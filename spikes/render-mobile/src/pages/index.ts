import '../styles.css';

import { toPasteText } from '../metrics/stats.ts';
import { collectDeviceInfo } from '../harness/device.ts';
import { setupNativeChecks } from '../harness/native.ts';
import { clearReports, copyText, loadReports } from '../harness/storage.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

const formatSel = el<HTMLSelectElement>('opt-format');
const resSel = el<HTMLSelectElement>('opt-res');
const links = { pixi: el<HTMLAnchorElement>('link-pixi'), phaser: el<HTMLAnchorElement>('link-phaser') };
el('ver-pixi').textContent = __PIXI_VERSION__;
el('ver-phaser').textContent = __PHASER_VERSION__;

const updateLinks = (): void => {
  const p = new URLSearchParams();
  p.set('format', formatSel.value);
  if (resSel.value) p.set('res', resSel.value);
  links.pixi.href = `./pixi.html?${p.toString()}`;
  links.phaser.href = `./phaser.html?${p.toString()}`;
};
formatSel.addEventListener('change', updateLinks);
resSel.addEventListener('change', updateLinks);
updateLinks();

const deviceEl = el<HTMLDListElement>('device');
for (const [k, v] of Object.entries(collectDeviceInfo())) {
  const dt = document.createElement('dt');
  dt.textContent = k;
  const dd = document.createElement('dd');
  dd.textContent = v === null ? 'n/a' : String(v);
  deviceEl.append(dt, dd);
}

const allResults = el<HTMLTextAreaElement>('all-results');
const statusEl = el<HTMLParagraphElement>('index-status');
const renderSaved = (): string => {
  const reports = loadReports();
  el('saved-summary').textContent =
    reports.length === 0
      ? 'Todavía no hay resultados (se guardan al terminar un benchmark, un test de contexto o al copiar).'
      : reports.map((r) => `${r.renderer.id} · ${r.variant.format} · ${r.variant.resolution}× · ${r.benchmarks.length} bench`).join(' | ');
  const text = reports.map(toPasteText).join('\n---\n\n');
  allResults.value = text;
  return text;
};
renderSaved();
el('copy-all').addEventListener('click', () => {
  void (async () => {
    const text = renderSaved();
    if (!text) {
      statusEl.textContent = 'No hay nada para copiar.';
      return;
    }
    statusEl.textContent = (await copyText(text, allResults)) ? 'Copiado.' : 'No se pudo copiar: seleccionar el texto manualmente.';
  })();
});
el('clear-all').addEventListener('click', () => {
  clearReports();
  renderSaved();
  statusEl.textContent = 'Resultados borrados.';
});

setupNativeChecks(el<HTMLElement>('native-card'));
