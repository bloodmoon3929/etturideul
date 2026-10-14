// 모듈 E: 3D 취향 지도 (PLAN 12장). 게시물을 3D 공간의 점으로 띄우고 비슷한 것끼리 선으로 잇는다.
// 좌표·엣지·군집은 scripts/build_graph.py가 미리 계산한 graph.json을 쓴다. 런타임에는 UMAP을 돌리지 않는다.
//
// 라이브러리: 3d-force-graph(three.js 포함, 전역 ForceGraph3D) + 스프라이트용 three 모듈.

import * as THREE from 'three';
import { url, CATEGORIES } from './config.js';
import { db, thumbUrl } from './data.js';
import { logger } from './logger.js';
import { ml } from './ml.js';
import { nav } from './nav.js';
import { kv } from './store.js';
import { task } from './task-frame.js';
import { h, won } from './util.js';
import { postCard, detailScreen } from './ui.js';

const PALETTE = ['#ff8a5c', '#5cc8ff', '#ffd45c', '#9d8cff', '#6ee7a8', '#ff7eb6', '#7dd3c8', '#f4a261', '#b8e05c', '#c59bff', '#ffb3a1', '#8fb8ff'];
const GRAY = '#6b7280';
const DIM = '#2a2f3a';
const COLOR_MODES = [['category', '카테고리'], ['series', '시리즈'], ['cluster', '자동 군집'], ['price', '가격대']];
const SPRITE_DISTANCE = 140;   // 이 거리 안의 노드만 썸네일을 띄운다
const MAX_SPRITES = 14;
const LIGHT_FPS = 20;

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const script = h('script', { src: url('vendor/3d-force-graph/3d-force-graph.min.js'), onload: resolve, onerror: () => reject(new Error('3d-force-graph 로드 실패')) });
      document.head.append(script);
    });
  }
  return libPromise;
}

function colorScales() {
  const series = new Map();
  for (const p of db.posts) series.set(p.series, (series.get(p.series) || 0) + 1);
  const topSeries = [...series.entries()].filter(([s]) => s !== '기타').sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length - 1).map(([s]) => s);
  const prices = db.posts.map((p) => p.price).sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map((q) => prices[Math.floor(prices.length * q)]);
  const priceColors = ['#ffe9c7', '#ffbf7a', '#ff8a5c', '#d9482b'];
  const priceBin = (v) => cuts.findIndex((c) => v < c) === -1 ? 3 : cuts.findIndex((c) => v < c);
  return {
    category: { of: (n) => PALETTE[CATEGORIES.indexOf(n.post.category) % PALETTE.length], legend: CATEGORIES.map((c, i) => [PALETTE[i], c]) },
    series: {
      of: (n) => (topSeries.includes(n.post.series) ? PALETTE[topSeries.indexOf(n.post.series)] : GRAY),
      legend: [...topSeries.map((s, i) => [PALETTE[i], s]), [GRAY, '기타']],
    },
    cluster: {
      of: (n) => (n.cluster < 0 ? GRAY : PALETTE[n.cluster % PALETTE.length]),
      legend: [...db.graph.clusters.map((c) => [PALETTE[c.id % PALETTE.length], c.label]), [GRAY, '미분류']],
    },
    price: {
      of: (n) => priceColors[priceBin(n.post.price)],
      legend: [`~${won(cuts[0])}`, `~${won(cuts[1])}`, `~${won(cuts[2])}`, `${won(cuts[2])}~`].map((label, i) => [priceColors[i], label]),
    },
  };
}

export function graphScreen({ search = null } = {}) {
  const g = db.graph;
  let Graph = null;
  let colorMode = 'category';
  let layout = 'umap';
  let light = false;
  let selected = null;          // 선택한 노드
  let highlight = null;         // 강조할 노드 id 집합 (없으면 전부 보통)
  let userId = '';
  let alive = true;
  const timers = [];
  const scales = colorScales();
  const textures = new Map();

  const nodes = g.nodes.map((n) => ({ ...n, kind: 'post', post: db.byId.get(n.id), fx: n.x, fy: n.y, fz: n.z, home: { x: n.x, y: n.y, z: n.z } }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const baseLinks = g.links.map((l) => ({ source: l.s, target: l.t, tier: l.tier, score: l.score, kind: 'sim' }));
  const neighbors = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
  for (const l of g.links) { neighbors.get(l.s).add(l.t); neighbors.get(l.t).add(l.s); }
  let extraNodes = [];
  let extraLinks = [];

  // ── 화면 요소 ───────────────────────────────────────────────────────
  const canvasHost = h('div', { class: 'graph-canvas' });
  const labelLayer = h('div', { class: 'graph-labels' });
  const legend = h('div', { class: 'graph-legend' });
  const panel = h('div', { class: 'graph-panel', hidden: true });
  const hint = h('div', { class: 'graph-hint', hidden: true }, '한 손가락으로 돌리고, 두 손가락으로 확대·이동해 보세요');
  const colorSelect = h('select', { class: 'input', 'aria-label': '색상 기준', onchange: (e) => setColorMode(e.target.value) },
    COLOR_MODES.map(([value, label]) => h('option', { value }, `색: ${label}`)));
  const layoutBtn = h('button', { class: 'btn', type: 'button', onclick: toggleLayout }, '배치: 임베딩');
  const userSelect = h('select', { class: 'input', 'aria-label': '사용자 취향 보기', onchange: (e) => setUser(e.target.value) },
    h('option', { value: '' }, '취향 보기'), g.users.map((u) => h('option', { value: u.id }, u.name)));
  const el = h('div', { class: 'module graph-screen' },
    canvasHost, labelLayer,
    h('div', { class: 'graph-toolbar' }, colorSelect, layoutBtn, userSelect),
    legend, hint, panel);

  const labelEls = g.clusters.map((c) => {
    const btn = h('button', { class: 'graph-label', type: 'button', onclick: () => focusCluster(c) }, c.label);
    labelLayer.append(btn);
    return { cluster: c, btn };
  });

  // ── 색·강조 ─────────────────────────────────────────────────────────
  const nodeColor = (n) => {
    if (n.kind === 'user') return '#ffe14d';
    if (n.kind === 'search') return '#ffffff';
    if (highlight && !highlight.has(n.id)) return DIM;
    return scales[colorMode].of(n);
  };
  const linkColor = (l) => {
    if (l.kind === 'like') return '#ffe14d';
    if (l.kind === 'rec') return '#7dd3fc';
    if (l.kind === 'search') return '#ffffff';
    const a = l.source.id ?? l.source, b = l.target.id ?? l.target;
    if (highlight && !(highlight.has(a) && highlight.has(b))) return '#1b1f27';
    return l.tier === 'same' ? '#ffd9a8' : '#59606e';
  };
  function repaint() {
    Graph.nodeColor(nodeColor).linkColor(linkColor);
    legend.replaceChildren(...scales[colorMode].legend.slice(0, 9).map(([color, label]) =>
      h('span', { class: 'legend-item' }, h('i', { style: { background: color } }), label)));
  }

  function setColorMode(mode) {
    colorMode = mode;
    logger.log('graph_toggle', 'color_select', { mode: 'color', value: mode });
    repaint();
  }

  // ── 카메라 ──────────────────────────────────────────────────────────
  function flyTo(point, distance = 70, ms = 900) {
    const len = Math.hypot(point.x, point.y, point.z) || 1;
    const ratio = 1 + distance / len;
    Graph.cameraPosition({ x: point.x * ratio, y: point.y * ratio, z: point.z * ratio }, point, ms);
    stopAutoRotate();
  }
  function stopAutoRotate() {
    const controls = Graph?.controls();
    if (controls) controls.autoRotate = false;
  }

  function clusterCenter(c) {
    const members = nodes.filter((n) => n.cluster === c.id);
    const sum = members.reduce((acc, n) => ({ x: acc.x + n.x, y: acc.y + n.y, z: acc.z + n.z }), { x: 0, y: 0, z: 0 });
    return { x: sum.x / members.length, y: sum.y / members.length, z: sum.z / members.length };
  }

  function focusCluster(c) {
    logger.log('graph_cluster_tap', 'cluster_label', { cluster_id: c.id, label: c.label });
    highlight = new Set(nodes.filter((n) => n.cluster === c.id).map((n) => n.id));
    selected = null;
    panel.hidden = true;
    repaint();
    flyTo(clusterCenter(c), 110);
  }

  // ── 노드 선택 ───────────────────────────────────────────────────────
  function selectNode(node) {
    if (node.kind !== 'post') return;
    selected = node;
    highlight = new Set(neighbors.get(node.id));   // 1-hop 이웃만 강조
    logger.log('graph_node_tap', 'node', { node_id: node.id, cluster_id: node.cluster, is_target: task.isTarget(node.post), n_neighbors: highlight.size - 1 });
    repaint();
    flyTo(node, 60);
    showPanel(node);
  }

  function showPanel(node) {
    const likeBtn = h('button', { class: 'btn', type: 'button' });
    const refresh = () => {
      const liked = task.likes.has(node.id);
      likeBtn.textContent = liked ? '♥ 찜함' : '♡ 찜';
      likeBtn.classList.toggle('on', liked);
    };
    likeBtn.onclick = () => { task.toggleLike(node.post, { from: 'e_graph' }); refresh(); };
    refresh();
    panel.replaceChildren(
      h('button', { class: 'icon-btn panel-close', type: 'button', 'aria-label': '닫기', onclick: clearSelection }, '✕'),
      postCard({ post: node.post }),
      h('div', { class: 'row' },
        likeBtn,
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          nav.push(detailScreen({ post: node.post }, { screenId: 'e_detail', from: 'e_graph', chain_depth: 0 }));
        } }, '상세 보기')));
    panel.hidden = false;
  }

  function clearSelection() {
    selected = null;
    highlight = userId ? userHighlight() : null;
    panel.hidden = true;
    repaint();
  }

  // ── 추가 노드: 사용자 취향(별), 내 검색 ─────────────────────────────
  function applyData() {
    Graph.graphData({ nodes: [...nodes, ...extraNodes], links: [...baseLinks, ...extraLinks] });
  }

  const currentUser = () => g.users.find((u) => u.id === userId);
  const userHighlight = () => new Set([`user:${userId}`, ...currentUser().likes, ...currentUser().recs]);

  function setUser(id) {
    userId = id;
    logger.log('graph_toggle', 'user_select', { mode: 'user', value: id || null });
    extraNodes = extraNodes.filter((n) => n.kind !== 'user');
    extraLinks = extraLinks.filter((l) => l.kind !== 'like' && l.kind !== 'rec');
    if (!id) {
      highlight = null;
      applyData();
      repaint();
      return;
    }
    const u = currentUser();
    const star = { id: `user:${u.id}`, kind: 'user', user: u, x: u.x, y: u.y, z: u.z, fx: u.x, fy: u.y, fz: u.z, deg: 6 };
    extraNodes.push(star);
    extraLinks.push(...u.likes.map((pid) => ({ source: star.id, target: pid, kind: 'like' })),
      ...u.recs.map((pid) => ({ source: star.id, target: pid, kind: 'rec' })));
    highlight = userHighlight();
    applyData();
    repaint();
    flyTo(star, 120);
    panel.replaceChildren(
      h('button', { class: 'icon-btn panel-close', type: 'button', 'aria-label': '닫기', onclick: () => { panel.hidden = true; } }, '✕'),
      h('strong', null, `★ ${u.name}`), h('p', { class: 'hint' }, u.desc),
      h('p', { class: 'hint' }, `노란 선: 찜한 굿즈 ${u.likes.length}개 · 하늘색 선: 추천 후보 ${u.recs.length}개`));
    panel.hidden = false;
  }

  // "내 검색" 노드: 좌표는 상위 결과 노드 좌표의 유사도 가중 평균 (PLAN 12.3)
  function showSearch({ label, results }) {
    const hits = results.map((r) => ({ node: nodeById.get(r.post.id), w: Math.max(r.score, 0.05) })).filter((x) => x.node);
    if (!hits.length) return;
    const total = hits.reduce((s, x) => s + x.w, 0);
    const pos = hits.reduce((acc, x) => ({ x: acc.x + x.node.x * x.w / total, y: acc.y + x.node.y * x.w / total, z: acc.z + x.node.z * x.w / total }), { x: 0, y: 0, z: 0 });
    const me = { id: 'search', kind: 'search', label, ...pos, fx: pos.x, fy: pos.y, fz: pos.z, deg: 8 };
    extraNodes.push(me);
    extraLinks.push(...hits.map((x) => ({ source: 'search', target: x.node.id, kind: 'search' })));
    highlight = new Set(['search', ...hits.map((x) => x.node.id)]);
    applyData();
    repaint();
    flyTo(me, 110, 1400);
    panel.replaceChildren(h('strong', null, `내 검색: ${label}`), h('p', { class: 'hint' }, `가장 비슷한 굿즈 ${hits.length}개와 선으로 이었어요.`));
    panel.hidden = false;
  }

  // ── 배치 전환: 임베딩 좌표(UMAP 고정) ↔ 힘 기반 ─────────────────────
  function toggleLayout() {
    layout = layout === 'umap' ? 'force' : 'umap';
    layoutBtn.textContent = layout === 'umap' ? '배치: 임베딩' : '배치: 연결 중심';
    logger.log('graph_toggle', 'btn_layout', { mode: 'layout', value: layout });
    if (layout === 'force') {
      for (const n of nodes) { n.fx = undefined; n.fy = undefined; n.fz = undefined; }
      Graph.cooldownTime(5000).d3ReheatSimulation();
      return;
    }
    const from = nodes.map((n) => ({ x: n.x, y: n.y, z: n.z }));
    const t0 = performance.now();
    Graph.cooldownTime(1500).d3ReheatSimulation();
    const step = () => {
      if (!alive) return;
      const t = Math.min(1, (performance.now() - t0) / 900);
      const e = t * t * (3 - 2 * t);
      nodes.forEach((n, i) => {
        n.fx = from[i].x + (n.home.x - from[i].x) * e;
        n.fy = from[i].y + (n.home.y - from[i].y) * e;
        n.fz = from[i].z + (n.home.z - from[i].z) * e;
      });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── 노드 모양 ───────────────────────────────────────────────────────
  function nodeObject(n) {
    if (n.kind === 'user') {
      return new THREE.Mesh(new THREE.OctahedronGeometry(7), new THREE.MeshBasicMaterial({ color: '#ffe14d' }));
    }
    if (n.kind === 'search') {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new THREE.SphereGeometry(5, 16, 16), new THREE.MeshBasicMaterial({ color: '#ffffff' })));
      group.add(new THREE.Mesh(new THREE.SphereGeometry(9, 16, 16), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.25 })));
      return group;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    sprite.scale.set(16, 16, 1);
    sprite.visible = false;
    n.sprite = sprite;
    return sprite;
  }

  // 카메라에 가까운 노드만 썸네일을 불러와 띄운다 (PLAN 12.4)
  function updateSprites() {
    if (!Graph || light) return;
    const cam = Graph.camera().position;
    const near = nodes
      .map((n) => ({ n, d: Math.hypot(n.x - cam.x, n.y - cam.y, n.z - cam.z) }))
      .filter((x) => x.d < SPRITE_DISTANCE).sort((a, b) => a.d - b.d).slice(0, MAX_SPRITES);
    const show = new Set(near.map((x) => x.n.id));
    for (const n of nodes) {
      if (!n.sprite) continue;
      const visible = show.has(n.id);
      if (visible && !n.sprite.material.map) {
        let tex = textures.get(n.id);
        if (!tex) {
          tex = new THREE.TextureLoader().load(thumbUrl(n.post));
          tex.colorSpace = THREE.SRGBColorSpace;
          textures.set(n.id, tex);
        }
        n.sprite.material.map = tex;
        n.sprite.material.needsUpdate = true;
      }
      n.sprite.visible = visible;
    }
  }

  function updateLabels() {
    if (!Graph) return;
    const w = canvasHost.clientWidth, hgt = canvasHost.clientHeight;
    const cam = Graph.camera();
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    for (const { cluster, btn } of labelEls) {
      const c = layout === 'umap' ? cluster : clusterCenter(cluster);
      const behind = (c.x - cam.position.x) * forward.x + (c.y - cam.position.y) * forward.y + (c.z - cam.position.z) * forward.z < 0;
      const p = Graph.graph2ScreenCoords(c.x, c.y, c.z);
      const hidden = behind || p.x < 0 || p.y < 40 || p.x > w || p.y > hgt - 20;
      btn.hidden = hidden;
      if (!hidden) btn.style.transform = `translate(-50%, -50%) translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }
  }

  // ── 초기화 ──────────────────────────────────────────────────────────
  async function init() {
    await Promise.all([loadLib(), ml.idle()]);   // 임베딩 추론이 도는 중이면 끝난 뒤에 GPU를 쓴다
    if (!alive) return;
    Graph = window.ForceGraph3D({ controlType: 'orbit', rendererConfig: { antialias: true, alpha: false, powerPreference: 'default' } })(canvasHost)
      .backgroundColor('#0b0d12').showNavInfo(false)
      .width(canvasHost.clientWidth).height(canvasHost.clientHeight)
      .nodeRelSize(2.2).nodeVal((n) => 1.4 + (n.deg || 0) * 0.45).nodeOpacity(0.95).nodeResolution(12)
      .nodeLabel(() => '').nodeThreeObject(nodeObject).nodeThreeObjectExtend((n) => n.kind === 'post')
      .linkWidth((l) => (l.kind === 'sim' && l.tier === 'same' ? 1.1 : 0)).linkOpacity(0.5)
      .linkDirectionalParticles((l) => (l.kind === 'sim' && l.tier === 'same') || l.kind === 'search' ? 2 : 0)
      .linkDirectionalParticleSpeed(0.007).linkDirectionalParticleWidth(1.6)
      .enableNodeDrag(false).cooldownTime(1500)
      .onNodeClick(selectNode).onBackgroundClick(clearSelection);
    Graph.renderer().setPixelRatio(Math.min(devicePixelRatio, 2));
    applyData();
    repaint();
    Graph.cameraPosition({ x: 0, y: 0, z: 330 });
    const controls = Graph.controls();
    controls.autoRotate = true;      // 처음엔 천천히 자동 회전, 손을 대면 멈춘다
    controls.autoRotateSpeed = 0.7;
    canvasHost.addEventListener('pointerdown', stopAutoRotate, { passive: true });
    logger.log('graph_enter', null, { n_nodes: nodes.length, n_links: baseLinks.length, from_search: !!search });

    timers.push(setInterval(updateSprites, 400));
    let lastCam = '';
    timers.push(setInterval(() => {   // 카메라 위치를 1초 간격으로 기록 (움직였을 때만)
      const p = Graph.camera().position;
      const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
      if (key === lastCam) return;
      lastCam = key;
      logger.log('graph_camera', null, { camera: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, target: selected?.id ?? null });
    }, 1000));
    const labelLoop = () => { if (!alive) return; updateLabels(); requestAnimationFrame(labelLoop); };
    requestAnimationFrame(labelLoop);
    measureFps();

    if (!(await kv.get('graph_hint_seen'))) {
      hint.hidden = false;
      setTimeout(() => { hint.hidden = true; }, 5000);
      kv.set('graph_hint_seen', true);
    }
    if (search) showSearch(search);
  }

  // 첫 2초 평균 fps가 낮으면 입자·썸네일을 끄는 가벼운 모드로 바꾼다
  function measureFps() {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      if (!alive) return;
      frames += 1;
      const elapsed = performance.now() - t0;
      if (elapsed < 2000) return requestAnimationFrame(tick);
      const fps = Math.round((frames * 1000) / elapsed);
      light = fps < LIGHT_FPS;
      if (light) {
        Graph.linkDirectionalParticles(0).nodeResolution(6);
        Graph.renderer().setPixelRatio(1);
        for (const n of nodes) if (n.sprite) n.sprite.visible = false;
      }
      logger.log('perf', 'graph', { fps, light_mode: light });
    };
    requestAnimationFrame(tick);
  }

  const onResize = () => Graph?.width(canvasHost.clientWidth).height(canvasHost.clientHeight);
  window.addEventListener('resize', onResize);
  let started = false;

  return {
    id: 'e_graph', el,
    onShow: () => {
      if (!started) {
        started = true;
        init().catch((err) => {
          logger.log('error', 'graph', { message: String(err.message || err) });
          canvasHost.append(h('p', { class: 'empty' }, `지도를 불러오지 못했어요: ${err.message || err}`));
        });
      } else {
        Graph?.resumeAnimation();
        onResize();
      }
    },
    onHide: () => Graph?.pauseAnimation(),
    onDestroy: () => {
      alive = false;
      timers.forEach(clearInterval);
      window.removeEventListener('resize', onResize);
      for (const tex of textures.values()) tex.dispose();
      Graph?.pauseAnimation();
      Graph?._destructor?.();
      Graph = null;
    },
  };
}

export const rootScreen = () => graphScreen();
