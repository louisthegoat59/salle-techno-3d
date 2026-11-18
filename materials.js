// Close-up detail + reflections on top of the baked (unlit) GLB.
//
// The GLB stays a plain baked model: each surface keeps its baked atlas (colour + Cycles lighting), and its
// material name says what it is: M_<group>__<class> (build/bake.py). Here each class gets
//   - a tiled detail texture on UV1 (joints, grain, weave...), sharp at 20 cm where the atlas is 3-4 mm/px;
//   - for shiny classes, reflections of the room: a cube map captured from the model itself at load time,
//     box-projected onto the room so they stay put as you move, with Fresnel, roughness and a normal map.
// Lighting stays the baked one: the detail multiplies it, the reflections are added on top.
// Small things also get prints (classes dk_<material>, and st_<material> for stickers): keyboard legends, PC
// fronts, labels... The print replaces the colour, not the light: the baked texel is taken back through the
// bake's tone curve to scene light, divided by the albedo the bake used (A0) and multiplied by the print's.
import * as THREE from 'three';

const SETS = {           // texture set -> which maps exist (export/textures/detail/<set>_d / _n)
  tile: { d: 1, n: 1 }, ceiling: { d: 1 }, wall: { d: 1 }, beech: { d: 1, n: 1 },
  plastic: { d: 1, n: 1 }, paint: { n: 1 }, linen: { d: 1 },
  rubber: { d: 1, n: 1 }, brushed: { d: 1, n: 1 }, fabric: { d: 1 }, cardboard: { d: 1 }, paper: { d: 1 },
  pegboard: { d: 1 }, leather: { d: 1, n: 1 }, tread: { d: 1, n: 1 }, chain: { d: 1, n: 1 },
};
// rough: base roughness; roughK/roughT: darker detail (joints) gets rougher; spec: reflection strength;
// ns: normal map strength; f0: reflectance at normal incidence (0.04 for paint, plastic, glaze, varnish)
// occ: baked brightness range over which reflections fade in (no glow under desks); only for light surfaces,
// where dark in the bake means shadow (on black plastic it would just mean black)
const CLASSES = {
  tile:     { set: 'tile', rough: 0.17, roughK: 2.4, roughT: 0.6, spec: 0.55, ns: 1.0, occ: [0.02, 0.22] },
  beech:    { set: 'beech', rough: 0.42, roughK: 0.4, roughT: 1.04, spec: 0.6, ns: 0.5, occ: [0.01, 0.12] },
  laminate: { set: 'plastic', rough: 0.32, spec: 0.7, ns: 0.5, occ: [0.02, 0.2] },
  plastic:  { set: 'plastic', rough: 0.52, spec: 0.45, ns: 0.5 },
  paint:    { set: 'paint', rough: 0.36, spec: 0.7, ns: 0.8 },
  gloss:    { rough: 0.04, spec: 1.0 },
  metal:    { rough: 0.16, spec: 1.0, f0: 0.6 },
  wall:     { set: 'wall', matte: 1 },
  ceiling:  { set: 'ceiling', matte: 1 },
  curtain:  { set: 'linen', matte: 1 },
  // small things (2026-11-18)
  brushed:   { set: 'brushed', rough: 0.3, spec: 1.0, f0: 0.55, ns: 0.6 },
  bikepaint: { set: 'paint', rough: 0.14, spec: 1.0, f0: 0.05, ns: 0.25 },
  rubber:    { set: 'rubber', rough: 0.72, spec: 0.3, ns: 0.8 },
  tread:     { set: 'tread', rough: 0.68, spec: 0.35, ns: 1.0 },
  leather:   { set: 'leather', rough: 0.42, spec: 0.5, ns: 0.8 },
  chain:     { set: 'chain', rough: 0.35, spec: 0.9, f0: 0.5, ns: 1.0 },
  bag:       { set: 'plastic', rough: 0.2, spec: 0.8, ns: 1.0 },
  cable:     { rough: 0.3, spec: 0.5 },
  fabric:    { set: 'fabric', matte: 1 },
  cardboard: { set: 'cardboard', matte: 1 },
  paper:     { set: 'paper', matte: 1 },
  pegboard:  { set: 'pegboard', matte: 1 },
  matte:     { matte: 1 },
};

export async function upgradeMaterials(gltf, renderer, scene, opts = {}) {
  const items = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const nm = o.material.name || '';
    const m = /^M_(\w+?)__(\w+)$/.exec(nm);
    if (m && /^(dk|st)_/.test(m[2]) && o.material.map) items.push({ o, cls: m[2] });
    else if (m && CLASSES[m[2]] && o.material.map) items.push({ o, cls: m[2] });
    else if (nm === 'M_glass') items.push({ o, cls: 'glass' });
  });
  if (!items.length) return { upgraded: 0 };          // an older GLB without surface classes
  const q = opts.q || new URLSearchParams();
  const lite = q.has('lite');

  // room box (walls) and a probe in the middle of the room, at chest height
  const box = new THREE.Box3();
  gltf.scene.traverse((o) => { if (o.isMesh && /^M_walls__/.test(o.material.name)) box.expandByObject(o); });
  const probe = box.getCenter(new THREE.Vector3());
  probe.y = 1.45;
  const env = lite ? null : captureProbe(renderer, scene, gltf.scene, probe);

  // detail textures (shared)
  const ext = opts.vr ? 'ktx2' : 'jpg';
  const cache = new Map();
  const tl = new THREE.TextureLoader();
  const load = (url) => {
    if (!cache.has(url)) {
      cache.set(url, (ext === 'ktx2' ? opts.ktx2.loadAsync(url) : tl.loadAsync(url)).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.flipY = false;
        t.colorSpace = THREE.NoColorSpace;
        t.channel = 1;
        t.anisotropy = opts.aniso || 1;
        t.needsUpdate = true;
        return t;
      }).catch(() => null));        // a set not generated yet: the class keeps its reflections only
    }
    return cache.get(url);
  };
  const base = 'textures/detail/';
  const uniforms = {
    uBoxMin: { value: box.min.clone() }, uBoxMax: { value: box.max.clone() }, uProbe: { value: probe.clone() },
  };

  // prints: atlas (colour + coverage), emission atlas (half size), and the bake's tone curve
  const prints = items.some((it) => /^(dk|st)_/.test(it.cls))
    ? await fetch(`${base}prints.json`).then((r) => r.json()).catch(() => null) : null;
  let PT = null;
  if (prints) {
    const [pa, pe] = await Promise.all([
      (opts.vr ? opts.ktx2.loadAsync(`${base}print_a.ktx2`) : tl.loadAsync(`${base}print_a.png`)),
      (opts.vr ? opts.ktx2.loadAsync(`${base}print_e.ktx2`) : tl.loadAsync(`${base}print_e.jpg`)),
    ]);
    for (const t of [pa, pe]) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.channel = 1;
      t.anisotropy = opts.aniso || 1;
      t.needsUpdate = true;
    }
    PT = { a: pa, e: pe, cfg: prints, glsl: lutGLSL(prints.lut) };
  }

  let n = 0;
  const swaps = [];       // [mesh, full material, light material] for the automatic fallback in VR
  await Promise.all(items.map(async ({ o, cls }) => {
    const old = o.material;
    const pm = /^(dk|st)_(\w+)$/.exec(cls);
    if (pm) {
      if (!PT) return;
      const mat = pm[2];
      const a0 = PT.cfg.a0[mat] || PT.cfg.a0[mat.replace(/_\d+$/, '')] || [0.5, 0.5, 0.5];
      const P = CLASSES[PT.cfg.cls[mat] || 'plastic'] || CLASSES.plastic;
      const sticker = pm[1] === 'st';
      const light = printMaterial(old, P, a0, PT, null, uniforms, sticker);
      if (lite || P.matte || !P.spec) {
        o.material = light;
      } else {
        o.material = printMaterial(old, P, a0, PT, env, uniforms, sticker);
        swaps.push([o, o.material, light]);
      }
      old.dispose();
      n++;
      return;
    }
    if (cls === 'glass') {
      if (lite) return;
      o.material = reflective(old, { rough: 0.02, spec: 1.0, glass: 1 }, null, null, env, uniforms);
      swaps.push([o, o.material, old]);
      n++;
      return;
    }
    const P = CLASSES[cls];
    const S = P.set ? SETS[P.set] : {};
    const [D, Nm] = await Promise.all([
      S.d ? load(`${base}${P.set}_d.${ext}`) : null,
      S.n && !P.matte ? load(`${base}${P.set}_n.${ext}`) : null,
    ]);
    const baked = old.map;
    baked.channel = 0;
    // matte: baked light x detail, nothing view-dependent (cheap)
    const flat = D ? new THREE.MeshBasicMaterial({
      name: old.name, map: D, color: new THREE.Color(2, 2, 2), lightMap: baked, lightMapIntensity: Math.PI,
      side: old.side, toneMapped: false,
    }) : old;
    if (P.matte || lite) {
      o.material = flat;
    } else {
      o.material = reflective(old, P, D, Nm, env, uniforms);
      swaps.push([o, o.material, flat]);
    }
    if (o.material !== old && flat !== old) old.dispose();
    n++;
  }));
  // lighter look (no reflections) for headsets that cannot keep up; reversible
  const setLite = (on) => { for (const [o, full, light] of swaps) o.material = on ? light : full; };
  return { upgraded: n, probe, setLite, reflective: swaps.length };
}

// Cube map of the room seen from the probe, with the baked look. Lamps and windows are clipped to 1.0 in the
// baked textures, so their brightness is expanded back (pseudo-HDR) before filtering: their reflections in
// the glazed tiles and the screens then read as light sources, not grey patches.
function captureProbe(renderer, scene, root, pos) {
  const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(0.05, 200, rt);
  cam.position.copy(pos);
  const swaps = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = o.material.clone();
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
        float L_ = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
        float k_ = clamp( ( L_ - 0.8 ) / 0.2, 0.0, 1.0 );
        outgoingLight *= 1.0 + 14.0 * k_ * k_;
        #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'probe-expand';
    swaps.push([o, o.material]);
    o.material = m;
  });
  const bg = scene.background;
  scene.add(cam);
  cam.update(renderer, scene);
  scene.remove(cam);
  scene.background = bg;
  for (const [o, m] of swaps) { o.material.dispose(); o.material = m; }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(rt.texture).texture;
  pmrem.dispose();
  rt.dispose();
  return env;
}

function reflective(old, P, D, Nm, env, U) {
  const glass = !!P.glass;
  const m = new THREE.MeshStandardMaterial({
    name: old.name,
    color: glass ? old.color.clone() : (D ? new THREE.Color(2, 2, 2) : new THREE.Color(1, 1, 1)),
    map: D || null,
    normalMap: Nm || null,
    // OpenGL normal maps (+Y = image up) on glTF UVs (v down) with derivative tangents: flip Y,
    // as GLTFLoader itself does (three.js issue 11438)
    normalScale: new THREE.Vector2(P.ns || 1, -(P.ns || 1)),
    lightMap: glass ? null : old.map,
    roughness: P.rough,
    metalness: 0,
    envMap: env,
    side: old.side,
    transparent: glass || old.transparent,
    opacity: old.opacity,
    depthWrite: glass ? false : old.depthWrite,
    toneMapped: false,
  });
  const f0 = P.f0 ?? 0.04;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, {
      uRoughK: { value: P.roughK || 0 }, uRoughT: { value: P.roughT || 0 },
      uSpec: { value: P.spec ?? 1 }, uF0: { value: new THREE.Vector3(f0, f0, f0) },
      uOcc: { value: new THREE.Vector2(...(P.occ || [-1, 0])) },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    const head = `
      uniform vec3 uBoxMin; uniform vec3 uBoxMax; uniform vec3 uProbe;
      uniform float uRoughK; uniform float uRoughT; uniform float uSpec; uniform vec3 uF0; uniform vec2 uOcc;
      varying vec3 vWPos;
      vec3 boxProject( vec3 r ) {        // parallax-corrected direction for a room-sized probe
        vec3 p = clamp( vWPos, uBoxMin + 0.02, uBoxMax - 0.02 );
        r = sign( r ) * max( abs( r ), vec3( 1e-4 ) );
        vec3 tf = max( ( uBoxMax - p ) / r, ( uBoxMin - p ) / r );
        float d = min( min( tf.x, tf.y ), tf.z );
        return normalize( p + r * d - uProbe );
      }`;
    const body = `
      vec3 V_ = normalize( vViewPosition );
      float lumD_ = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      float rgh_ = clamp( material.roughness + uRoughK * max( 0.0, uRoughT - lumD_ ), 0.03, 1.0 );
      float nv_ = saturate( dot( normal, V_ ) );
      vec4 r_ = rgh_ * vec4( -1.0, -0.0275, -0.572, 0.022 ) + vec4( 1.0, 0.0425, 1.04, -0.04 );
      float a_ = min( r_.x * r_.x, exp2( -9.28 * nv_ ) ) * r_.x + r_.y;
      vec2 ab_ = vec2( -1.04, 1.04 ) * a_ + r_.zw;
      vec3 F_ = uF0 * ab_.x + ab_.y;
      vec3 R_ = boxProject( inverseTransformDirection( reflect( -V_, normal ), viewMatrix ) );
      vec3 env_ = textureCubeUV( envMap, R_, rgh_ ).rgb;
      ${glass ? `
      float Fg_ = F_.x * uSpec;
      float aO_ = diffuseColor.a + Fg_ * ( 1.0 - diffuseColor.a );
      vec3 outgoingLight = ( diffuseColor.rgb * diffuseColor.a * ( 1.0 - Fg_ ) + env_ * Fg_ ) / max( aO_, 1e-3 );
      diffuseColor.a = aO_;` : `
      vec3 baked_ = texture2D( lightMap, vLightMapUv ).rgb;
      float occ_ = smoothstep( uOcc.x, uOcc.y, dot( baked_, vec3( 0.2126, 0.7152, 0.0722 ) ) );   // no glow under desks
      vec3 outgoingLight = baked_ * diffuseColor.rgb * ( 1.0 - F_ * uSpec ) + env_ * F_ * ( uSpec * occ_ );`}
    `;
    let fs = sh.fragmentShader.replace('void main() {', head + '\nvoid main() {');
    const a = fs.indexOf('#include <lights_fragment_begin>');
    const bEnd = 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;';
    const b = fs.indexOf(bEnd);
    if (a < 0 || b < 0) throw new Error('three.js shader layout changed');
    fs = fs.slice(0, a) + body + fs.slice(b + bEnd.length);
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (glass ? 'baked-glass' : 'baked-pbr');
  return m;
}

// The bake's tone curve (AgX, measured by build/agx_curve.py) as GLSL lookup tables
function lutGLSL(L) {
  const arr = (a) => a.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(', ');
  const k = L.g.length - 1;
  return `
    const float GF_[${k + 1}] = float[${k + 1}]( ${arr(L.g)} );
    const float GI_[${k + 1}] = float[${k + 1}]( ${arr(L.ginv)} );
    float gfwd_( float x ) {
      float f = clamp( ( x - ${L.x0.toFixed(2)} ) / ${(L.x1 - L.x0).toFixed(2)}, 0.0, 1.0 ) * ${k.toFixed(1)};
      int i = int( min( floor( f ), ${(k - 1).toFixed(1)} ) );
      return mix( GF_[i], GF_[i + 1], f - float( i ) );
    }
    float ginv_( float d ) {
      float f = clamp( d, 0.0, 1.0 ) * ${k.toFixed(1)};
      int i = int( min( floor( f ), ${(k - 1).toFixed(1)} ) );
      return mix( GI_[i], GI_[i + 1], f - float( i ) );
    }
    vec3 l2s_( vec3 c ) { c = max( c, vec3( 0.0 ) ); return mix( 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, 12.92 * c, vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) ); }
    vec3 s2l_( vec3 c ) { return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) ); }`;
}

// A print: colour from the print atlas, light from the bake (see the top of this file), emission added,
// reflections of the room on top for shiny materials. Stickers sit 0.4 mm above their face: polygon offset,
// and cut out where the print is transparent.
function printMaterial(old, P, a0, PT, env, U, sticker) {
  const spec = env && !P.matte ? (P.spec ?? 0.4) : 0;
  const m = new THREE.MeshStandardMaterial({
    name: old.name, color: 0xffffff, map: PT.a, emissiveMap: PT.e, emissive: 0xffffff,
    lightMap: old.map, roughness: P.rough ?? 0.5, metalness: 0, envMap: spec > 0 ? env : null,
    side: old.side, toneMapped: false,
    alphaTest: sticker ? 0.5 : 0, alphaToCoverage: sticker,
    polygonOffset: sticker, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  old.map.channel = 0;
  const f0 = P.f0 ?? 0.04;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, {
      uA0: { value: new THREE.Vector3(...a0) }, uSpec: { value: spec }, uF0: { value: new THREE.Vector3(f0, f0, f0) },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    const head = `
      uniform vec3 uBoxMin; uniform vec3 uBoxMax; uniform vec3 uProbe;
      uniform vec3 uA0; uniform float uSpec; uniform vec3 uF0;
      varying vec3 vWPos;
      ${PT.glsl}
      vec3 boxProject( vec3 r ) {
        vec3 p = clamp( vWPos, uBoxMin + 0.02, uBoxMax - 0.02 );
        r = sign( r ) * max( abs( r ), vec3( 1e-4 ) );
        vec3 tf = max( ( uBoxMax - p ) / r, ( uBoxMin - p ) / r );
        float d = min( min( tf.x, tf.y ), tf.z );
        return normalize( p + r * d - uProbe );
      }`;
    const body = `
      vec3 baked_ = texture2D( lightMap, vLightMapUv ).rgb;
      vec3 dsp_ = l2s_( baked_ );
      vec3 x_ = vec3( ginv_( dsp_.r ), ginv_( dsp_.g ), ginv_( dsp_.b ) );
      vec3 r_ = mix( vec3( 1.0 ), diffuseColor.rgb / uA0, clamp( diffuseColor.a, 0.0, 1.0 ) );
      x_ += log2( max( r_, vec3( 1e-4 ) ) );
      vec3 col_ = s2l_( vec3( gfwd_( x_.r ), gfwd_( x_.g ), gfwd_( x_.b ) ) );
      ${spec > 0 ? `
      vec3 V_ = normalize( vViewPosition );
      float rgh_ = clamp( material.roughness, 0.03, 1.0 );
      float nv_ = saturate( dot( normal, V_ ) );
      vec4 rr_ = rgh_ * vec4( -1.0, -0.0275, -0.572, 0.022 ) + vec4( 1.0, 0.0425, 1.04, -0.04 );
      float a_ = min( rr_.x * rr_.x, exp2( -9.28 * nv_ ) ) * rr_.x + rr_.y;
      vec2 ab_ = vec2( -1.04, 1.04 ) * a_ + rr_.zw;
      vec3 F_ = uF0 * ab_.x + ab_.y;
      vec3 R_ = boxProject( inverseTransformDirection( reflect( -V_, normal ), viewMatrix ) );
      vec3 env_ = textureCubeUV( envMap, R_, rgh_ ).rgb;
      vec3 outgoingLight = col_ * ( 1.0 - F_ * uSpec ) + env_ * F_ * uSpec + totalEmissiveRadiance;` : `
      vec3 outgoingLight = col_ + totalEmissiveRadiance;`}
    `;
    let fs = sh.fragmentShader.replace('void main() {', head + '\nvoid main() {');
    const a = fs.indexOf('#include <lights_fragment_begin>');
    const bEnd = 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;';
    const b = fs.indexOf(bEnd);
    if (a < 0 || b < 0) throw new Error('three.js shader layout changed');
    sh.fragmentShader = fs.slice(0, a) + body + fs.slice(b + bEnd.length);
  };
  m.customProgramCacheKey = () => `baked-print${spec > 0 ? '-env' : ''}${sticker ? '-st' : ''}`;
  return m;
}
