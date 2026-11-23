/**
 * Browser 3Dmol.js viewer (CDN). Used on home hero and molecule profiles.
 */

const sdfCache = new Map();
let scriptPromise = null;

function load3Dmol() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.$3Dmol) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-flux-3dmol="true"]');
    if (existing) {
      if (window.$3Dmol) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load 3Dmol")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/3Dmol/2.4.2/3Dmol-min.js";
    script.async = true;
    script.dataset.flux3dmol = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load 3Dmol"));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

async function loadSdf(cid) {
  const cached = sdfCache.get(cid);
  if (cached != null) return cached;
  const res = await fetch(`/api/molecules-structure?cid=${encodeURIComponent(cid)}`);
  if (!res.ok) return null;
  const sdf = await res.text();
  if (!sdf.trim()) return null;
  sdfCache.set(cid, sdf);
  return sdf;
}

/**
 * Mount a 3Dmol viewer into `container`.
 * @param {HTMLElement} root
 * @param {{ cid: number, autoRotate?: boolean, interactive?: boolean }} options
 * @returns {{ destroy: () => void }}
 */
export function mountMoleculeViewer(root, options) {
  const { cid, autoRotate = true, interactive = true } = options;
  const canvas = document.createElement("div");
  canvas.className = "molecule-viewer__canvas";
  canvas.setAttribute("aria-label", `3D structure for PubChem CID ${cid}`);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.minHeight = "280px";
  canvas.style.pointerEvents = interactive ? "auto" : "none";

  const overlay = document.createElement("div");
  overlay.className = "molecule-viewer__overlay";
  overlay.setAttribute("role", "status");
  overlay.textContent = "Rendering structure…";

  root.classList.add("molecule-viewer");
  root.replaceChildren(canvas, overlay);

  let viewer = null;
  let cancelled = false;
  let visible = typeof IntersectionObserver === "undefined";
  let removeResize;
  let removeVisibility;
  let io;

  function setOverlay(text) {
    if (!text) {
      overlay.remove();
      return;
    }
    overlay.textContent = text;
    if (!overlay.isConnected) root.appendChild(overlay);
  }

  async function run() {
    if (!visible || cancelled) return;
    setOverlay("Rendering structure…");
    try {
      await load3Dmol();
      if (cancelled || !window.$3Dmol) return;

      const sdf = await loadSdf(cid);
      if (cancelled) return;
      if (!sdf) {
        setOverlay("Structural data is not available for this molecule.");
        return;
      }

      canvas.innerHTML = "";
      viewer = window.$3Dmol.createViewer(canvas, {
        backgroundColor: "0x111e2e",
        antialias: false,
        id: `flux-viewer-${cid}`,
      });
      viewer.clear();
      viewer.addModel(sdf, "sdf");
      viewer.setStyle(
        {},
        {
          stick: { radius: 0.15, colorscheme: "Jmol" },
          sphere: { scale: 0.24, colorscheme: "Jmol" },
        },
      );
      viewer.zoomTo();
      viewer.zoom(1.08, 0);
      viewer.render();

      const onResize = () => {
        if (!viewer) return;
        viewer.resize();
        viewer.render();
      };
      window.addEventListener("resize", onResize, { passive: true });
      removeResize = () => window.removeEventListener("resize", onResize);

      const onVisibility = () => {
        if (!viewer) return;
        if (document.hidden) viewer.spin(false);
        else if (autoRotate) viewer.spin("y", 0.22);
      };
      document.addEventListener("visibilitychange", onVisibility);
      removeVisibility = () =>
        document.removeEventListener("visibilitychange", onVisibility);

      if (autoRotate && !document.hidden) viewer.spin("y", 0.22);
      setOverlay("");

      if (interactive) {
        const hint = document.createElement("p");
        hint.className = "molecule-viewer__hint";
        hint.textContent = "Drag to rotate · Scroll to zoom";
        root.appendChild(hint);
      }
    } catch {
      if (!cancelled) setOverlay("Unable to load the molecular visualization.");
    }
  }

  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible) void run();
        else viewer?.spin(false);
      },
      { rootMargin: "120px", threshold: 0.01 },
    );
    io.observe(root);
  } else {
    void run();
  }

  return {
    destroy() {
      cancelled = true;
      viewer?.spin(false);
      viewer = null;
      removeResize?.();
      removeVisibility?.();
      io?.disconnect();
      root.replaceChildren();
    },
  };
}
