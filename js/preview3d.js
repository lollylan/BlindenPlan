// 3D-Vorschau mit Three.js (Z nach oben, Millimeter).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Preview {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e7e2d8');
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -220, 220);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.requestRender());

    const hemi = new THREE.HemisphereLight(0xffffff, 0x9a9387, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(160, -260, 420);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-300, 200, 150);
    this.scene.add(fill);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.animating = false;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.animating) return;
    this.animating = true;
    const loop = () => {
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (moving) requestAnimationFrame(loop); else this.animating = false;
    };
    requestAnimationFrame(loop);
  }

  clear() {
    for (const obj of [...this.group.children, ...this.helpers.children]) {
      obj.parent.remove(obj);
      obj.geometry?.dispose();
      if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
    }
  }

  /**
   * @param model  Ergebnis von buildModel
   * @param {{colorMode:'split'|'rooms', baseColor:string, raisedColor:string, bed?:{w:number,h:number}}} opts
   */
  setModel(model, opts) {
    this.clear();
    const bbox = new THREE.Box3();
    for (const piece of model.pieces) {
      for (const part of piece.parts) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(part.tris, 3));
        geo.computeVertexNormals();
        let color;
        if (opts.colorMode === 'rooms') {
          if (part.kind === 'base') color = (piece.id === 'plan' || piece.id === 'legend') ? opts.baseColor : lighten(piece.color, 0.45);
          else color = part.color || opts.raisedColor;
        } else {
          color = part.kind === 'base' ? opts.baseColor : opts.raisedColor;
        }
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.8, metalness: 0.0, flatShading: true });
        const mesh = new THREE.Mesh(geo, mat);
        this.group.add(mesh);
        geo.computeBoundingBox();
        bbox.union(geo.boundingBox);
      }
    }
    if (opts.bed) {
      const { w, h } = opts.bed;
      const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(w, 0, 0), new THREE.Vector3(w, h, 0), new THREE.Vector3(0, h, 0), new THREE.Vector3(0, 0, 0)];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9a9387 }));
      line.position.z = -0.05;
      this.helpers.add(line);
      const grid = new THREE.GridHelper(Math.max(w, h), Math.round(Math.max(w, h) / 10), 0xc9c2b5, 0xd9d3c7);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(Math.max(w, h) / 2, Math.max(w, h) / 2, -0.1);
      this.helpers.add(grid);
    }
    if (!bbox.isEmpty()) this.fit(bbox);
    this.requestRender();
  }

  fit(bbox) {
    const size = new THREE.Vector3(); bbox.getSize(size);
    const center = new THREE.Vector3(); bbox.getCenter(center);
    const radius = Math.max(size.x, size.y, size.z, 10) * 0.65;
    const dist = radius / Math.sin((this.camera.fov * Math.PI / 180) / 2) * 1.05;
    this.camera.position.set(center.x + dist * 0.15, center.y - dist * 0.75, center.z + dist * 0.65);
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  topView() {
    const target = this.controls.target.clone();
    const d = this.camera.position.distanceTo(target);
    this.camera.position.set(target.x, target.y - 0.001, target.z + d);
    this.controls.update();
    this.requestRender();
  }
}

function lighten(hex, f) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color('#ffffff'), f);
  return `#${c.getHexString()}`;
}
