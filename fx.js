/* ============================================================
   AEROTWIN web · 后期光影合成器（fx.js）
   仅依赖已全局加载的 three.js（r128），经典 <script> 引入，运行时零额外依赖、零构建。

   自实现轻量合成器（全部用核心 three 的 RenderTarget + 全屏四边形 ShaderPass）：
     · Bloom 泛光      —— 亮度阈值提取 → 可分离高斯模糊 → 叠加（夜间灯光/太阳/金饰发光）
     · Tilt-shift 景深 —— 屏幕纵向渐变，对焦带外混入模糊场景（缩微模型质感）
     · FXAA            —— 渲到 RT 后补一道抗锯齿
     · ACES 色调映射   —— 可选（默认关闭，开启走 ACES+sRGB；关闭以保留原版深空配色）

   设计原则：
     1) 对焦带内、且无泛光处，输出与原版逐像素一致 —— 只「叠加」光影，不改既有配色；
     2) 任何着色器异常都由调用方 try/catch 优雅回退为 renderer.render，绝不致页面黑屏；
     3) 所有可视参数集中在 DEFAULTS，运行时可经 fx.cfg + fx.apply() 实时调。
   ============================================================ */
(function (global) {
  "use strict";
  const THREE = global.THREE;
  if (!THREE) { console.warn("[fx] THREE 未加载，后期合成器不可用"); return; }

  /* —— 可调参数（视觉调优集中处）——
     控制台实时调： AEROTWIN_FX.cfg.bloom.strength = 1.3; AEROTWIN_FX.apply();           */
  const DEFAULTS = {
    enabled: true,
    bloom: { enabled: true, threshold: 0.72, knee: 0.20, strength: 0.95, radius: 1.0, iterations: 3, scale: 4 },
    dof:   { enabled: true, focusY: 0.52, range: 0.16, strength: 0.62, radius: 1.4, iterations: 2, scale: 2 },
    fxaa:  { enabled: true },
    // ACES 高光柔化 + 轻度 sRGB，调和深空配色（invGamma：1.0=纯 ACES 不提亮，0.9=默认微提，0.4545=完整 sRGB 较亮）
    tone:  { enabled: true, exposure: 1.0, invGamma: 0.9 },
    // 热浪扰动：屏幕带状折射（band=带中心屏幕Y、width=带半高、amount=最大偏移）
    heat:  { enabled: true, amount: 0.0022, band: 0.4, width: 0.26 },
  };

  const VERT = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

  const FRAG_COPY = "varying vec2 vUv; uniform sampler2D tDiffuse; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }";

  /* 亮度软阈值提取（只放行高光：跑道灯/信标/太阳/金饰…） */
  const FRAG_BRIGHT = [
    "varying vec2 vUv; uniform sampler2D tDiffuse; uniform float threshold; uniform float knee;",
    "void main(){",
    "  vec4 c = texture2D(tDiffuse, vUv);",
    "  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));",
    "  float k = smoothstep(threshold, threshold + knee, l);",
    "  gl_FragColor = vec4(c.rgb * k, 1.0);",
    "}",
  ].join("\n");

  /* 可分离高斯（5 抽样线性采样近似 9 抽样核） */
  const FRAG_BLUR = [
    "varying vec2 vUv; uniform sampler2D tDiffuse; uniform vec2 dir;",
    "void main(){",
    "  vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;",
    "  vec2 o1 = dir * 1.3846153846; vec2 o2 = dir * 3.2307692308;",
    "  sum += texture2D(tDiffuse, vUv + o1) * 0.3162162162;",
    "  sum += texture2D(tDiffuse, vUv - o1) * 0.3162162162;",
    "  sum += texture2D(tDiffuse, vUv + o2) * 0.0702702703;",
    "  sum += texture2D(tDiffuse, vUv - o2) * 0.0702702703;",
    "  gl_FragColor = sum;",
    "}",
  ].join("\n");

  /* 合成：景深混合 + 泛光叠加 +（可选）ACES 色调映射 */
  const FRAG_COMP = [
    "varying vec2 vUv;",
    "uniform sampler2D tScene; uniform sampler2D tSceneBlur; uniform sampler2D tBloom;",
    "uniform float bloomStrength; uniform float focusY; uniform float range; uniform float dofStrength;",
    "uniform int dofOn; uniform int bloomOn; uniform int toneOn; uniform float exposure; uniform float invGamma;",
    "uniform int heatOn; uniform float heatAmt; uniform float heatBand; uniform float heatWidth; uniform float time;",
    "vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }",
    "void main(){",
    "  vec2 uv = vUv;",
    "  if (heatOn == 1) {",                              // 跑道/喷流热浪：屏幕带状折射扰动
    "    float mask = smoothstep(heatWidth, 0.0, abs(vUv.y - heatBand));",
    "    float w = sin(vUv.x * 38.0 + time * 2.3) * sin(vUv.y * 70.0 + time * 3.1);",
    "    uv.x += w * heatAmt * mask; uv.y += w * heatAmt * 0.5 * mask;",
    "  }",
    "  vec3 col = texture2D(tScene, uv).rgb;",
    "  if (dofOn == 1) {",
    "    vec3 blurd = texture2D(tSceneBlur, uv).rgb;",
    "    float d = abs(vUv.y - focusY);",
    "    float coc = clamp((d - range) / max(range, 1e-4), 0.0, 1.0);",
    "    coc = pow(coc, 1.3) * dofStrength;",
    "    col = mix(col, blurd, coc);",
    "  }",
    "  if (bloomOn == 1) { col += texture2D(tBloom, uv).rgb * bloomStrength; }",
    "  if (toneOn == 1) { col *= exposure; col = aces(col); col = pow(col, vec3(invGamma)); }",
    "  gl_FragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");

  /* FXAA（NVIDIA FXAA3 console 版，经典实现） */
  const FRAG_FXAA = [
    "varying vec2 vUv; uniform sampler2D tDiffuse; uniform vec2 texel;",
    "void main(){",
    "  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0,-1.0)*texel).rgb;",
    "  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0,-1.0)*texel).rgb;",
    "  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0, 1.0)*texel).rgb;",
    "  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0, 1.0)*texel).rgb;",
    "  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;",
    "  vec3 luma = vec3(0.299, 0.587, 0.114);",
    "  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);",
    "  float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);",
    "  float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));",
    "  float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));",
    "  vec2 dir = vec2(-((lNW+lNE)-(lSW+lSE)), ((lNW+lSW)-(lNE+lSE)));",
    "  float reduce = max((lNW+lNE+lSW+lSE)*0.25*0.125, 1.0/128.0);",
    "  float rcpMin = 1.0/(min(abs(dir.x), abs(dir.y)) + reduce);",
    "  dir = clamp(dir*rcpMin, -8.0, 8.0) * texel;",
    "  vec3 rgbA = 0.5*(texture2D(tDiffuse, vUv + dir*(1.0/3.0-0.5)).rgb + texture2D(tDiffuse, vUv + dir*(2.0/3.0-0.5)).rgb);",
    "  vec3 rgbB = rgbA*0.5 + 0.25*(texture2D(tDiffuse, vUv + dir*(-0.5)).rgb + texture2D(tDiffuse, vUv + dir*(0.5)).rgb);",
    "  float lB = dot(rgbB, luma);",
    "  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);",
    "}",
  ].join("\n");

  function deepMerge(base, over) {
    const out = {};
    for (const k in base) {
      out[k] = (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]))
        ? deepMerge(base[k], (over && over[k]) || {})
        : (over && k in over ? over[k] : base[k]);
    }
    return out;
  }

  function createFX(renderer, scene, camera, opts) {
    const cfg = deepMerge(DEFAULTS, opts || {});

    // 全屏四边形装置（顶点直接落在裁剪空间，与相机无关）
    const fsScene = new THREE.Scene();
    const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const shader = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    const mCopy   = shader(FRAG_COPY,   { tDiffuse: { value: null } });
    const mBright = shader(FRAG_BRIGHT, { tDiffuse: { value: null }, threshold: { value: cfg.bloom.threshold }, knee: { value: cfg.bloom.knee } });
    const mBlur   = shader(FRAG_BLUR,   { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } });
    const mComp   = shader(FRAG_COMP,   {
      tScene: { value: null }, tSceneBlur: { value: null }, tBloom: { value: null },
      bloomStrength: { value: cfg.bloom.strength }, focusY: { value: cfg.dof.focusY },
      range: { value: cfg.dof.range }, dofStrength: { value: cfg.dof.strength },
      dofOn: { value: cfg.dof.enabled ? 1 : 0 }, bloomOn: { value: cfg.bloom.enabled ? 1 : 0 },
      toneOn: { value: cfg.tone.enabled ? 1 : 0 }, exposure: { value: cfg.tone.exposure }, invGamma: { value: cfg.tone.invGamma },
      heatOn: { value: cfg.heat.enabled ? 1 : 0 }, heatAmt: { value: cfg.heat.amount }, heatBand: { value: cfg.heat.band }, heatWidth: { value: cfg.heat.width }, time: { value: 0 },
    });
    const mFxaa   = shader(FRAG_FXAA,   { tDiffuse: { value: null }, texel: { value: new THREE.Vector2() } });
    const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mCopy);
    fsQuad.frustumCulled = false;
    fsScene.add(fsQuad);

    const makeRT = (w, h, depth) => new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: !!depth, stencilBuffer: false,
    });

    let rtScene, rtFinal, dofA, dofB, bloomA, bloomB, W = 1, H = 1;
    function dispose() { [rtScene, rtFinal, dofA, dofB, bloomA, bloomB].forEach((rt) => rt && rt.dispose()); }
    function setSize(w, h) {
      W = Math.max(1, w | 0); H = Math.max(1, h | 0);
      dispose();
      rtScene = makeRT(W, H, true);
      rtFinal = makeRT(W, H, false);
      dofA = makeRT(W / cfg.dof.scale, H / cfg.dof.scale, false);
      dofB = makeRT(W / cfg.dof.scale, H / cfg.dof.scale, false);
      bloomA = makeRT(W / cfg.bloom.scale, H / cfg.bloom.scale, false);
      bloomB = makeRT(W / cfg.bloom.scale, H / cfg.bloom.scale, false);
    }

    const draw = (mat, target) => { fsQuad.material = mat; renderer.setRenderTarget(target || null); renderer.render(fsScene, fsCam); };

    // 可分离高斯：src→A(水平)→B(竖直)，迭代后结果恒在 B；A、B 同尺寸 ping-pong
    function blur(srcTex, A, B, radius, iters) {
      let src = srcTex;
      for (let i = 0; i < iters; i++) {
        mBlur.uniforms.tDiffuse.value = src;       mBlur.uniforms.dir.value.set(radius / A.width, 0); draw(mBlur, A);
        mBlur.uniforms.tDiffuse.value = A.texture; mBlur.uniforms.dir.value.set(0, radius / A.height); draw(mBlur, B);
        src = B.texture;
      }
      return B.texture;
    }

    function render() {
      if (!cfg.enabled) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }

      renderer.setRenderTarget(rtScene); renderer.render(scene, camera);     // ① 实景

      let sceneBlurTex = rtScene.texture, bloomTex = rtScene.texture;
      if (cfg.dof.enabled) sceneBlurTex = blur(rtScene.texture, dofA, dofB, cfg.dof.radius, cfg.dof.iterations);   // ② 景深模糊
      if (cfg.bloom.enabled) {                                               // ③ 泛光
        mBright.uniforms.tDiffuse.value = rtScene.texture; draw(mBright, bloomA);
        bloomTex = blur(bloomA.texture, bloomB, bloomA, cfg.bloom.radius, cfg.bloom.iterations);
      }

      mComp.uniforms.tScene.value = rtScene.texture;                         // ④ 合成
      mComp.uniforms.tSceneBlur.value = sceneBlurTex;
      mComp.uniforms.tBloom.value = bloomTex;
      mComp.uniforms.time.value = performance.now() * 0.001;
      draw(mComp, cfg.fxaa.enabled ? rtFinal : null);

      if (cfg.fxaa.enabled) {                                                // ⑤ 抗锯齿
        mFxaa.uniforms.tDiffuse.value = rtFinal.texture;
        mFxaa.uniforms.texel.value.set(1 / W, 1 / H);
        draw(mFxaa, null);
      }
      renderer.setRenderTarget(null);
    }

    // 把 cfg 同步进 uniforms（实时调参用；改 scale/iterations 需重新 setSize）
    function apply() {
      mBright.uniforms.threshold.value = cfg.bloom.threshold;
      mBright.uniforms.knee.value = cfg.bloom.knee;
      mComp.uniforms.bloomStrength.value = cfg.bloom.strength;
      mComp.uniforms.focusY.value = cfg.dof.focusY;
      mComp.uniforms.range.value = cfg.dof.range;
      mComp.uniforms.dofStrength.value = cfg.dof.strength;
      mComp.uniforms.dofOn.value = cfg.dof.enabled ? 1 : 0;
      mComp.uniforms.bloomOn.value = cfg.bloom.enabled ? 1 : 0;
      mComp.uniforms.toneOn.value = cfg.tone.enabled ? 1 : 0;
      mComp.uniforms.exposure.value = cfg.tone.exposure;
      mComp.uniforms.invGamma.value = cfg.tone.invGamma;
      mComp.uniforms.heatOn.value = cfg.heat.enabled ? 1 : 0;
      mComp.uniforms.heatAmt.value = cfg.heat.amount;
      mComp.uniforms.heatBand.value = cfg.heat.band;
      mComp.uniforms.heatWidth.value = cfg.heat.width;
    }

    return { render, setSize, dispose, apply, cfg };
  }

  global.AeroFX = { createFX };
})(typeof window !== "undefined" ? window : globalThis);
