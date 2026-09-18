/**
 * Enemy - 敵の共通ロジック(移動・HP・当たり判定・撃破処理)を持つ基底クラス
 * ============================================================
 * 担当: 敵挙動担当メンバー
 *
 * 見た目・敵タイプごとの挙動は、このクラスを継承したサブクラスで実装する。
 * (例: EnemyDrone.js  ─ ドローン型の敵。銃口をプレイヤーへ向け、接近せず射撃する)
 *  EnemyMonster.js ─ モンスター型の敵。GLBモデル + 手続き的な歩行アニメーション)
 * 敵タイプを追加するメンバーは、このファイルを直接編集せず、新しいサブクラスファイルを
 * 作って _createMesh() / _updateMovement() / _updateVisual() / _onReset() をオーバーライド
 * すること。これにより複数人が同時に別の敵タイプを作ってもファイルが競合しない。
 *
 * 作業ガイド:
 *   - _createMesh() で見た目を変更できる(デフォルトはウェーブに応じて変化する発光多面体+ワイヤーフレーム)
 *   - _updateMovement() で動き方を変えられる(デフォルトは直進)
 *   - _updateVisual() で見た目の更新(回転演出・照準など)を変えられる
 *   - _onReset() でプール再利用時の見た目更新方法を変えられる(デフォルトはウェーブ色の再適用)
 *   - hit() でヒット時の演出を追加できる
 *   - Config.ENEMY の値でパラメータ調整
 *
 * NOTE: 敵はプール方式で再利用される(EnemySpawner._spawnEnemy 参照)。
 *       撃破・到達時にメッシュを破棄せず reset() で使い回すため、
 *       マテリアルは _trackMaterial() 経由で登録すること(hit flash / 死亡フェード / reset に必要)。
 *
 * このファイルで触るもの: このファイルのみ
 * このファイルで触らないもの: EventBus, Config(値は変更OK), App.js
 * ============================================================
 */

import * as THREE from 'three';
import EventBus from '../common/EventBus.js';
import Config from '../common/Config.js';

export class Enemy {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} spawnPosition
   * @param {object} options
   * @param {number} options.hp
   * @param {number} options.speed
   * @param {number} options.wave
   */
  constructor(scene, spawnPosition, options = {}) {
    this.scene = scene;
    this.hp = options.hp ?? Config.ENEMY.BASE_HP;
    this.speed = options.speed ?? Config.ENEMY.BASE_SPEED;
    this.wave = options.wave ?? 1;

    this.isDefeated = false;
    this.isActive = true;

    // ヒット時のフラッシュ演出用タイマー
    this._hitFlashTimer = 0;
    // ヒットフラッシュ・撃破処理で操作するマテリアル一覧
    // (サブクラスが複数メッシュ構成のモデルを使う場合も、_trackMaterial() に積めば共通処理が効く)
    this._materials = [];
    // フラッシュ対象外だが、撃破時のフェードアウトは行う装飾用マテリアル(ワイヤーフレーム等)
    this._wireMaterials = [];

    // 撃破時の吹き飛びアニメーション(ゲームループ管理)
    this._dying        = false;
    this._dyingElapsed = 0;
    this._dyingDur     = 0.45;
    this._dyingVel     = new THREE.Vector3();
    // スポーン時のスケールイン演出タイマー(秒)
    this._spawnTimer = 0.25;

    // フレームごとに再利用するVector3(GCを避けるためキャッシュ)
    this._direction = new THREE.Vector3();
    this._reachRadiusSq = Config.ENEMY.REACH_RADIUS * Config.ENEMY.REACH_RADIUS;

    this.mesh = this._createMesh();
    this.mesh.scale.setScalar(0.01); // スポーン演出: 小さい状態から始まる
    this.mesh.position.copy(spawnPosition);
    this.scene.add(this.mesh);
  }

  /**
   * マテリアルを _materials に登録し、ヒットフラッシュ/フェードの復帰基準値を記録する。
   * サブクラスが独自メッシュ(GLBモデル等)を使う場合もこれを呼べば共通処理が効く。
   * @param {THREE.Material} material
   */
  _trackMaterial(material) {
    material.userData._baseEmissiveIntensity = material.emissiveIntensity ?? 0;
    material.userData._baseOpacity = material.opacity ?? 1;
    this._materials.push(material);
  }

  /**
   * 敵のメッシュを生成する
   * ウェーブ段階に応じてジオメトリが変化し、難易度を視覚的に伝える
   *   Wave 1-2: TetrahedronGeometry (4面体・小型・鋭角)
   *   Wave 3-4: OctahedronGeometry  (8面体・中型・標準)
   *   Wave 5+ : IcosahedronGeometry (20面体・大型・複雑)
   * @returns {THREE.Object3D}
   */
  _createMesh() {
    // ウェーブが進むごとに色相が変わる(難易度の視覚フィードバック)
    const hue = (this.wave * 0.15) % 1.0;
    this._color = new THREE.Color().setHSL(hue, 1.0, 0.55);

    // ウェーブ段階に応じてジオメトリ・サイズを変える
    let geometry;
    if (this.wave <= 2) {
      geometry = new THREE.TetrahedronGeometry(0.22, 0);
    } else if (this.wave <= 4) {
      geometry = new THREE.OctahedronGeometry(0.25, 0);
    } else {
      geometry = new THREE.IcosahedronGeometry(0.28, 0);
    }

    // ソリッドマテリアル: 高光沢・強めの自発光でネオン感を出す
    const material = new THREE.MeshPhongMaterial({
      color: this._color,
      emissive: this._color,
      emissiveIntensity: 2.5, // XR疑似ブルーム: 強めの自発光でグロー感を出す
      shininess: 150,
      specular: new THREE.Color(0xffffff),
      transparent: true,
      opacity: 0.88,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    this._trackMaterial(material);

    // ワイヤーフレームオーバーレイ: サイバーパンク風の縁取り
    const wireMat = new THREE.MeshBasicMaterial({
      color: this._color,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
    });
    wireMat.userData._baseOpacity = wireMat.opacity;
    const wireMesh = new THREE.Mesh(geometry, wireMat);
    wireMesh.scale.setScalar(1.09); // 少し大きくしてソリッドからはみ出させる
    mesh.add(wireMesh);
    this._wireMaterials.push(wireMat);

    return mesh;
  }

  /**
   * 毎フレーム呼ばれる更新処理
   * @param {number} delta - 前フレームからの経過時間(秒)
   * @param {THREE.Vector3} playerPosition - プレイヤーの現在位置
   */
  update(delta, playerPosition) {
    // 撃破後の吹き飛びアニメーション(WebXR対応: ゲームループで処理)
    if (this._dying) {
      this._updateDying(delta);
      return;
    }
    if (!this.isActive || this.isDefeated) return;

    // ---- スポーンアニメーション: 0→1.15→1.0 のオーバーシュートスケール ----
    if (this._spawnTimer > 0) {
      this._spawnTimer -= delta;
      const t = 1 - Math.max(0, this._spawnTimer) / 0.25;
      // 0〜0.75で1.15まで拡大、0.75〜1.0で1.0に収束
      const s = t < 0.75 ? (t / 0.75) * 1.15 : 1.15 - ((t - 0.75) / 0.25) * 0.15;
      this.mesh.scale.setScalar(Math.max(0.01, s));
      if (this._spawnTimer <= 0) this.mesh.scale.setScalar(1);
    }

    // ---- 移動(サブクラスでオーバーライド可能) ----
    this._updateMovement(delta, playerPosition);

    // ---- 見た目の更新(回転演出・照準など。サブクラスでオーバーライド可能) ----
    this._updateVisual(delta, playerPosition);

    // ---- ヒットフラッシュ解除 ----
    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= delta;
      if (this._hitFlashTimer <= 0) {
        for (const mat of this._materials) {
          mat.emissiveIntensity = mat.userData._baseEmissiveIntensity ?? 0;
        }
      }
    }

    // ---- プレイヤーへの到達判定 ----
    if (this.mesh.position.distanceToSquared(playerPosition) < this._reachRadiusSq) {
      this._onReachPlayer();
    }
  }

  /**
   * 移動処理
   * デフォルトはプレイヤーに向かって直進。敵タイプ固有の動き方(接近せず一定距離で
   * 停止するなど)はサブクラスでオーバーライドすること。
   * @param {number} delta
   * @param {THREE.Vector3} playerPosition
   */
  _updateMovement(delta, playerPosition) {
    this._direction.subVectors(playerPosition, this.mesh.position).normalize();
    this.mesh.position.addScaledVector(this._direction, this.speed * delta);
  }

  /**
   * 見た目の毎フレーム更新(回転演出・照準など)
   * デフォルトはくるくる回転。敵タイプ固有の挙動はサブクラスでオーバーライドすること。
   * @param {number} delta
   * @param {THREE.Vector3} playerPosition
   */
  _updateVisual(delta, playerPosition) {
    this.mesh.rotation.x += delta * 1.5;
    this.mesh.rotation.y += delta * 2.0;
  }

  /**
   * 弾に当たったときの処理
   * @param {number} damage - ダメージ量(デフォルト1)
   */
  hit(damage = 1) {
    if (!this.isActive || this.isDefeated) return;

    this.hp -= damage;
    EventBus.emit('sound:play3d', { id: 'hit', position: this.position });

    // ヒットフラッシュ
    for (const mat of this._materials) mat.emissiveIntensity = 6.0; // 被弾フラッシュ
    this._hitFlashTimer = 0.1;

    if (this.hp <= 0) {
      this._defeat();
    }
  }

  /**
   * 撃破後の吹き飛びアニメーション (ゲームループから毎フレーム呼ばれる)
   * ※ WebXR では window.requestAnimationFrame が停止するため
   *    ゲームループ (EnemySpawner → Enemy.update) で処理する
   * @param {number} delta
   */
  _updateDying(delta) {
    this._dyingElapsed += delta;
    const t = Math.min(1, this._dyingElapsed / this._dyingDur);

    // 重力付き吹き飛び
    this._dyingVel.y -= 10 * delta;
    this.mesh.position.addScaledVector(this._dyingVel, delta);
    this.mesh.rotation.x += delta * 8;
    this.mesh.rotation.z += delta * 6;

    // フェードアウト(本体マテリアル + 装飾用マテリアル)
    for (const mat of this._materials) {
      mat.transparent = true;
      mat.opacity = Math.max(0, (mat.userData._baseOpacity ?? 1) * (1 - t));
    }
    for (const mat of this._wireMaterials) {
      mat.transparent = true;
      mat.opacity = Math.max(0, (mat.userData._baseOpacity ?? 1) * (1 - t));
    }

    if (t >= 1) {
      this._dying = false;
      if (this.mesh.parent) this.scene.remove(this.mesh);
    }
  }

  /**
   * 撃破時の処理
   */
  _defeat() {
    this.isDefeated = true;
    this.isActive = false;

    EventBus.emit('enemy:defeated', {
      enemy: this,
      score: Config.ENEMY.SCORE_PER_KILL * this.wave,
    });
    EventBus.emit('sound:play3d', { id: 'defeat', position: this.position });

    this._startDying();
  }

  /**
   * スコアを加算せずにその場で消滅させる(ゲームオーバー時の一斉消滅用)
   * @returns {boolean} 実際に消滅させたか
   */
  dissolve() {
    if (!this.isActive) return false;
    this.isDefeated = true;
    this.isActive   = false;
    this._startDying();
    return true;
  }

  /** 吹き飛び初期化(アニメーション本体は _updateDying でゲームループ処理) */
  _startDying() {
    this._dying        = true;
    this._dyingElapsed = 0;
    this._dyingVel.set(
      (Math.random() - 0.5) * 6,
      Math.random() * 4 + 2,
      (Math.random() - 0.5) * 6,
    );
  }

  /**
   * プレイヤーへの到達時の処理
   * プール再利用のため、メッシュ・マテリアルは破棄せずシーンから外すだけにする。
   */
  _onReachPlayer() {
    this.isActive = false;
    if (this.mesh.parent) this.scene.remove(this.mesh);

    EventBus.emit('enemy:reached-player', {
      enemy: this,
      damage: Config.PLAYER.DAMAGE_PER_ENEMY,
    });
    EventBus.emit('sound:play', { id: 'player-hit' });
  }

  /**
   * mesh配下の全ジオメトリ・マテリアルを破棄する(destroy() 専用。プール再利用時は呼ばない)
   */
  _disposeMesh() {
    this.mesh.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      child.material.dispose();
    });
  }

  /**
   * 敵の現在位置を返す
   * @returns {THREE.Vector3}
   */
  get position() {
    return this.mesh.position;
  }

  /**
   * プール再利用: 位置・パラメータをリセットしてシーンに戻す
   * 見た目の更新方法はサブクラスで異なるため _onReset() に委譲する。
   * @param {THREE.Vector3} spawnPosition
   * @param {{ hp: number, speed: number, wave: number }} options
   */
  reset(spawnPosition, options = {}) {
    this.hp    = options.hp    ?? Config.ENEMY.BASE_HP;
    this.speed = options.speed ?? Config.ENEMY.BASE_SPEED;
    this.wave  = options.wave  ?? 1;
    this.isDefeated = false;
    this.isActive   = true;
    this._hitFlashTimer = 0;
    this._reachRadiusSq = Config.ENEMY.REACH_RADIUS * Config.ENEMY.REACH_RADIUS;

    this._dying        = false; // 吹き飛びアニメーションをキャンセル
    this._dyingElapsed = 0;
    this._spawnTimer   = 0.25; // スポーンアニメーションをリセット
    this.mesh.scale.setScalar(0.01);

    this._onReset();

    this.mesh.position.copy(spawnPosition);
    if (!this.mesh.parent) this.scene.add(this.mesh);
  }

  /**
   * プール再利用時の見た目更新フック
   * デフォルトはウェーブに応じた色・不透明度を _materials / _wireMaterials に再適用する。
   * サブクラスで見た目の更新方法が異なる場合(GLBモデルなど)はオーバーライドすること。
   */
  _onReset() {
    const hue = (this.wave * 0.15) % 1.0;
    this._color = new THREE.Color().setHSL(hue, 1.0, 0.55);

    for (const mat of this._materials) {
      if (mat.color) mat.color.copy(this._color);
      if (mat.emissive) mat.emissive.copy(this._color);
      mat.emissiveIntensity = mat.userData._baseEmissiveIntensity ?? mat.emissiveIntensity;
      mat.opacity = mat.userData._baseOpacity ?? mat.opacity;
    }
    for (const mat of this._wireMaterials) {
      if (mat.color) mat.color.copy(this._color);
      mat.opacity = mat.userData._baseOpacity ?? mat.opacity;
    }
  }

  /**
   * 手動で敵を完全に破棄する(プールも含めて捨てる場合のみ使用)
   * 通常のゲームリセットは EnemySpawner.reset() がプールを維持したまま非アクティブ化するため、
   * 現状これは呼ばれない想定。将来プール自体を縮小する処理を作る場合に使う。
   */
  destroy() {
    this._dying = false; // 吹き飛びアニメーションをキャンセル
    if (this.mesh.parent) this.scene.remove(this.mesh);
    this._disposeMesh();
    this.isActive = false;
    this.isDefeated = true;
  }
}
