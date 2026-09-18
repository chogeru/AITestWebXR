/**
 * EnemyMonster - モンスター型の敵
 * ============================================================
 * 担当: 敵モデル担当メンバー
 *
 * Enemy(基底クラス)を継承し、見た目を monster.glb に差し替え、
 * ボーンを使わない手続き的アニメーションで「歩いている」ように見せる。
 * プレイヤーへは直進し(移動は基底クラスのまま)、常にプレイヤーの方を向く。
 *
 * ボーンが無いモデルなので、上下動・体重移動・前傾・スカッシュ&ストレッチを
 * 重ねて生き物らしさを出している(_applyWalkAnimation())。
 * 敵はプール方式で再利用されるため、モデル本来のテクスチャを保ったまま
 * ウェーブの違いは自発光の色味だけで表現する(_applyWaveLook())。
 * 他の敵タイプを追加する場合は、このファイルではなく新しいサブクラスファイルを作ること。
 *
 * このファイルで触るもの: このファイルのみ
 * このファイルで触らないもの: EventBus, Config(値は変更OK), Enemy.js, App.js
 * ============================================================
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Enemy } from './Enemy.js';

/** 3Dモデルの場所。差し替えるときはここを変える */
const MODEL_URL = '/assets/enemy/monster.glb';
/** ゲーム内での敵の高さ(m)。大きすぎると当たり判定とズレるので注意 */
const MODEL_HEIGHT = 0.55;

/** 自発光の強さ。モデルはテクスチャを潰さないよう弱めにする */
const MODEL_EMISSIVE = 0.15;
/** 被弾フラッシュの強さ。基底クラスの簡易図形向けの値だと白飛びするので抑える */
const HIT_EMISSIVE = 1.2;

/**
 * 手続き的アニメーションの調整値。
 * ボーンを入れずに「生きている感じ」を出すためのパラメータ。
 * TODO: 動きが硬い/大げさすぎる場合はここの数値を変える
 */
const ANIM = {
  BOB_HEIGHT:     0.05,  // 歩行の上下動(m)
  BOB_SPEED:      7.0,   // 歩く速さ。移動速度に比例させる
  ROLL:           0.10,  // 左右の体重移動(ラジアン)
  LEAN:           0.13,  // 進行方向への前傾(ラジアン)
  SQUASH:         0.07,  // 着地時に潰れる量
  HIT_SQUASH:     0.30,  // 被弾時に潰れる量
  HIT_SQUASH_DUR: 0.18,  // 被弾の潰れが戻るまで(秒)
  HIT_KNOCKBACK:  0.14,  // 被弾時にのけぞって下がる距離(m)
  RAGE_RANGE:     2.0,   // この距離まで近づくと動きが激しくなる(m)
  RAGE_BOOST:     1.9,   // 接近時の激しさの倍率
};

/**
 * 全個体で共有するモデルのテンプレート { geometry, material }。
 * ジオメトリは共有し、マテリアルだけ個体ごとに複製する
 * (ヒット時の発光を個別に変えるためマテリアルは共有できない)。
 * 敵1体ごとに読み込み直すと重いので、1度だけ読み込んで使い回す。
 * @type {Promise<{geometry: THREE.BufferGeometry, material: THREE.Material}|null>}
 */
const _templatePromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
  let source = null;
  gltf.scene.traverse((o) => { if (!source && o.isMesh) source = o; });
  if (!source) throw new Error('GLB内にメッシュが見つかりません');

  // GLB内の階層変換を焼き込んでから、ゲーム内のサイズに正規化する
  source.updateWorldMatrix(true, false);
  const geometry = source.geometry.clone();
  geometry.applyMatrix4(source.matrixWorld);

  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  const scale = MODEL_HEIGHT / (size.y || 1);
  geometry.scale(scale, scale, scale);

  // 原点を中心に揃える。スポーン位置は空中なので、足元基準のままだと
  // 見た目と当たり判定の中心がズレる
  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.computeBoundingSphere();

  return { geometry, material: source.material };
}).catch((e) => {
  console.warn(
    `[EnemyMonster] 敵モデルを読み込めませんでした: ${MODEL_URL}`, e,
    '\n簡易図形で代用します(ゲームは通常どおり動きます)。',
  );
  return null;
});

export class EnemyMonster extends Enemy {
  /**
   * 読み込み完了までは基底クラスのプレースホルダー(発光する多面体)を表示し、
   * 読み込み完了後にモンスターモデルへ差し替える。
   * @returns {THREE.Group}
   */
  _createMesh() {
    // ピボット: このGroupのローカル -Z が「敵の正面」。_updateVisual() で毎フレームlookAt()する。
    const pivot = new THREE.Group();

    this._placeholder = super._createMesh();
    pivot.add(this._placeholder);

    this._resetWalkState();

    _templatePromise.then((template) => this._onModelLoaded(template, pivot));

    return pivot;
  }

  /**
   * 歩行アニメーションの状態を初期化する。
   * 位相を個体ごとにずらさないと、全員が同じタイミングで跳ねて不自然になる。
   * 初回生成時(_createMesh)・プール再利用時(_onReset)の両方から呼ぶ。
   */
  _resetWalkState() {
    this._animPhase      = Math.random() * Math.PI * 2;
    this._animTime       = 0;
    this._bobOffset      = 0;   // 今フレームの上下動。次フレームで打ち消す
    this._hitSquashTimer = 0;
  }

  /**
   * モデルの読み込み完了時にプレースホルダーと差し替える
   * @param {{geometry: THREE.BufferGeometry, material: THREE.Material}|null} template
   * @param {THREE.Group} pivot
   */
  _onModelLoaded(template, pivot) {
    if (!template) return;

    pivot.remove(this._placeholder);
    this._placeholder.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      child.material.dispose();
    });
    this._placeholder = null;
    this._materials = [];
    this._wireMaterials = [];

    // ジオメトリは全個体で共有し、マテリアルだけ複製する
    const material = template.material.clone();
    material.emissive = new THREE.Color(0x000000); // _applyWaveLook で設定する
    material.transparent = true;                   // 撃破時のフェードアウトで使う
    this._applyWaveLook(material);

    const model = new THREE.Mesh(template.geometry, material);
    model.castShadow = true;
    // 共有ジオメトリなので破棄してはいけない(1体の破棄で他の敵まで壊れる)
    model.userData.sharedGeometry = true;

    this._trackMaterial(material);
    this._isModel = true;

    pivot.add(model);
  }

  /**
   * ウェーブに応じた見た目をマテリアルに反映する。
   * モデルは本来のテクスチャを活かしたいので色は白のまま、
   * ウェーブの違いは自発光の色味だけで表現する。
   * 読み込み時と _onReset() の両方から呼ぶので、ここだけ直せば両方に効く。
   * @param {THREE.Material} material
   */
  _applyWaveLook(material) {
    const hue = (this.wave * 0.15) % 1.0;
    this._color = new THREE.Color().setHSL(hue, 1.0, 0.55);

    material.color.set(0xffffff);
    material.emissive.copy(this._color);
    material.emissiveIntensity = MODEL_EMISSIVE;
    material.opacity = 1.0;
    // 基底クラスのヒットフラッシュ解除・撃破フェードが戻す基準値
    material.userData._baseEmissiveIntensity = MODEL_EMISSIVE;
    material.userData._baseOpacity = 1.0;
  }

  /**
   * 前フレームで足した上下動を戻してから基底クラスの直進移動を行う。
   * 戻さずに毎フレーム足すと、敵がどんどん浮き上がってしまう。
   * @param {number} delta
   * @param {THREE.Vector3} playerPosition
   */
  _updateMovement(delta, playerPosition) {
    this.mesh.position.y -= this._bobOffset;
    this._bobOffset = 0;

    super._updateMovement(delta, playerPosition);
  }

  /**
   * モデルは回すと転がって見えるので、回転演出の代わりにプレイヤーの方を向かせる。
   * 歩行の揺れは lookAt の後にローカル回転で足す(向きを崩さないため)。
   * モデル読み込み前は基底クラスの回転演出のままにする。
   * @param {number} delta
   * @param {THREE.Vector3} playerPosition
   */
  _updateVisual(delta, playerPosition) {
    if (!this._isModel) {
      super._updateVisual(delta, playerPosition);
      return;
    }

    this.mesh.lookAt(playerPosition);
    // スポーン演出中はスケールを基底クラスが操作しているので、歩行の潰れは重ねない
    if (this._spawnTimer <= 0) this._applyWalkAnimation(delta, playerPosition);
  }

  /**
   * 歩行アニメーション(ボーンを使わない手続き的アニメーション)
   *
   * 上下動・左右の体重移動・前傾・潰れを重ねて「生きている」感じを出す。
   * ボーンが無くても歩いているように見せるのが狙い。
   * NOTE: lookAt() の直後に呼ぶこと。rotateX/Z はローカル回転なので
   *       lookAt で決まった向きを保ったまま傾きだけ足せる。
   *
   * @param {number} delta
   * @param {THREE.Vector3} playerPosition
   */
  _applyWalkAnimation(delta, playerPosition) {
    // プレイヤーに近いほど動きを激しくして、迫ってくる圧を出す
    const dist = this.mesh.position.distanceTo(playerPosition);
    const rage = dist < ANIM.RAGE_RANGE
      ? 1 + (1 - dist / ANIM.RAGE_RANGE) * (ANIM.RAGE_BOOST - 1)
      : 1;

    // 歩幅は移動速度に比例させる(速い敵ほど忙しく歩く)
    this._animTime += delta * ANIM.BOB_SPEED * this.speed * rage;
    const t = this._animTime + this._animPhase;

    // 上下動: abs(sin) にすると「左足・右足」の2拍子になる
    const step = Math.abs(Math.sin(t));
    this._bobOffset = step * ANIM.BOB_HEIGHT * rage;

    // 体重移動(左右の揺れ)と前傾
    this.mesh.rotateZ(Math.sin(t * 0.5) * ANIM.ROLL * rage);
    this.mesh.rotateX(ANIM.LEAN * rage);

    // 着地の瞬間に潰れる(スカッシュ&ストレッチ)
    let squash = (1 - step) * ANIM.SQUASH;

    // 被弾直後はさらに強く潰す
    if (this._hitSquashTimer > 0) {
      this._hitSquashTimer -= delta;
      squash += (Math.max(0, this._hitSquashTimer) / ANIM.HIT_SQUASH_DUR) * ANIM.HIT_SQUASH;
    }
    // 縦に潰れたぶん横に広がると、弾力があるように見える
    this.mesh.scale.set(1 + squash * 0.7, 1 - squash, 1 + squash * 0.7);

    this.mesh.position.y += this._bobOffset;
  }

  /**
   * 被弾時に潰れてのけぞる演出を足す。
   * 基底クラスのフラッシュはネオン多面体向けに強すぎるので、モデル用に弱める。
   * @param {number} damage
   */
  hit(damage = 1) {
    const wasActive = this.isActive && !this.isDefeated;

    super.hit(damage);

    if (!wasActive || !this._isModel) return;

    for (const mat of this._materials) mat.emissiveIntensity = HIT_EMISSIVE;

    // 撃破済みなら吹き飛びアニメーションに任せる(のけぞりを重ねると位置が飛ぶ)
    if (this.isDefeated) return;

    // lookAt でプレイヤーを向いているので、ローカル +Z がプレイヤーと反対方向になる
    this._hitSquashTimer = ANIM.HIT_SQUASH_DUR;
    this.mesh.translateZ(ANIM.HIT_KNOCKBACK);
  }

  /**
   * プール再利用時の見た目更新フック。
   * モデル本来の色を保つため、基底クラスのようなウェーブ色の再着色は行わず、
   * 自発光の色味だけ更新する。歩行アニメーションの状態も戻す。
   */
  _onReset() {
    if (this._isModel) {
      for (const mat of this._materials) this._applyWaveLook(mat);
    } else {
      super._onReset();
    }
    this._resetWalkState();
  }

  /**
   * モデルのジオメトリは全個体で共有しているので破棄してはいけない
   * (1体の撃破で他の敵のジオメトリまで壊れてしまう)
   */
  _disposeMesh() {
    this.mesh.traverse((child) => {
      if (!child.isMesh) return;
      if (!child.userData.sharedGeometry) child.geometry.dispose();
      child.material.dispose();
    });
  }
}
