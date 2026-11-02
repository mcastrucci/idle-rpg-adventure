# Spike 2 — kit de prueba de render en móvil (PixiJS vs Phaser + Capacitor)

Issue: [#12](https://github.com/mcastrucci/idle-rpg-adventure/issues/12) · Valida [ADR-0010](../../docs/adr/0010-scene-renderer.md)
y [ADR-0011](../../docs/adr/0011-capacitor-mobile.md).

Este paquete **no decide nada**: produce la evidencia. La decisión de renderer y el go/no-go de Capacitor se toman
solo con números de **dispositivos reales** (AGENTS.md); las corridas en escritorio/headless son humo, no evidencia.

---

## Para el owner (español)

### Qué hay

- `index.html` — página inicial: elegir formato (WebP/PNG) y resolución, info del dispositivo (GPU, DPR, tamaño máx.
  de textura), instrucciones, y «Copiar todos» los resultados guardados en este teléfono.
- `pixi.html` y `phaser.html` — **la misma escena** (fondo ilustrado 1536×2048, 6 personajes con animaciones de
  respiración, embestida, destello de golpe, sacudida, muerte con fundido, partículas al golpear, hotspots tocables,
  transición fade/slide entre dos escenas) implementada con cada librería.
- Un **HUD de métricas** arriba (tocar «Panel» para abrir/cerrar): FPS promedio y 1 % low, tiempos de frame p50/p95,
  tiempo hasta el primer frame, tiempo de transición, memoria JS (solo Chrome; «n/a» en Safari), memoria de texturas
  estimada, pérdidas/restauraciones de contexto WebGL, idas a segundo plano y si el render se reanudó.

### Cómo abrirlo en el teléfono

Opción A — URL publicada (si el orquestador ya subió `dist/`): abrir esa URL en el teléfono.

Opción B — desde tu computadora, en la misma red Wi-Fi que el teléfono:

```bash
pnpm install
pnpm --filter @spikes/render-mobile dev -- --host
```

Vite muestra una dirección `Network: http://192.168.x.x:5180/`. Abrirla en el teléfono. (La primera vez genera las
imágenes: tarda ~15 s.) Para probar el build final: `pnpm --filter @spikes/render-mobile build` y
`pnpm --filter @spikes/render-mobile preview -- --host`.

> En `http://` con IP local el navegador puede bloquear el portapapeles: si «Copiar resultados» falla, el texto
> queda en la caja de abajo para seleccionarlo a mano.

### Dispositivos y navegadores

| Dispositivo | Navegadores |
|---|---|
| iPhone antiguo (11 o SE 2.ª/3.ª gen.) | Safari (y la app Capacitor, ver abajo) |
| Android con ~2 GB de RAM | Chrome (y la app Capacitor) |
| Opcional: tu teléfono actual | Safari/Chrome, como referencia |

### Protocolo (repetir para PixiJS y para Phaser, primero WebP y luego PNG)

1. Preparación: cerrar otras apps, batería > 50 %, sin ahorro de energía, brillo normal, teléfono frío. Resolución
   «auto» (DPR hasta 2×). Si sobra tiempo, repetir en «nativa» en el Android.
2. Abrir el renderer desde `index.html`. Esperar 5 s quieto.
3. **Benchmark normal:** abrir el Panel → «Benchmark 30 s». No tocar nada durante 30 s (el panel se cierra solo y se
   reabre con el resultado).
4. **Benchmark stress:** «Stress: OFF» → pasa a ON (×2 sprites y partículas) → «Benchmark 30 s» otra vez. Volver a
   poner Stress en OFF.
5. **Transiciones e interacción:** «Escena (fade)» y «Escena (slide)» dos veces cada una. Tocar personajes (destello +
   partículas), el círculo celeste (hotspot) y el círculo dorado (salida → cambia de escena).
6. **Segundo plano:** ir al inicio del teléfono (o cambiar de app) ~10 s y volver. En el panel: «Fondo / frente» y
   «reanudó: sí/NO». Si la escena queda negra o congelada, anotarlo.
7. **Pérdida de contexto:** «Simular pérdida de contexto». Esperar ~3 s: debe decir **PASS** y la escena debe verse
   igual que antes.
8. **Audio:** «Probar audio» — ¿se escuchó un pitido? (En iPhone, revisar el interruptor de silencio.)
9. **Copiar resultados** y pegarlo como comentario en el issue #12, indicando modelo del teléfono, versión de
   iOS/Android y navegador. Anotar a ojo: tirones visibles, calor, si la página se recargó sola (iOS mata la pestaña
   cuando se queda sin memoria — eso es un resultado importante).

Al final, en `index.html`, «Copiar todos» junta el último resultado de cada combinación renderer/formato/resolución
guardado en ese teléfono.

### Qué pegar en el issue

El botón copia una **tabla Markdown** (resumen) + un bloque **JSON** plegable con todos los datos. Pegarlo tal cual.
Además, en texto libre: modelo, SO, navegador/Capacitor, observaciones visuales, y cualquier recarga o crash.

---

## Capacitor (comandos; no se commitean proyectos nativos)

El kit no depende de Capacitor. Para envolver `dist/` en apps iOS/Android, crear un proyecto **fuera del repo**:

```bash
pnpm --filter @spikes/render-mobile build          # genera spikes/render-mobile/dist
mkdir -p ~/render-spike-cap && cd ~/render-spike-cap
npm init -y
npm i @capacitor/core@8.5.3 @capacitor/ios@8.5.3 @capacitor/android@8.5.3 \
      @capacitor/local-notifications@8.3.1 @revenuecat/purchases-capacitor@13.7.3
npm i -D @capacitor/cli@8.5.3 typescript
rm -rf www && cp -R /ruta/al/repo/spikes/render-mobile/dist www
```

`capacitor.config.ts` mínimo:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.idlerpg.renderspike',
  appName: 'Render Spike',
  webDir: 'www',
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_icon_config_sample', iconColor: '#FFD27A' },
  },
};

export default config;
```

```bash
npx cap add ios          # requiere macOS + Xcode + CocoaPods
npx cap add android      # requiere Android Studio / SDK
npx cap sync             # repetir cada vez que cambie www/
npx cap open ios         # ejecutar en el iPhone desde Xcode (equipo de firma personal alcanza)
npx cap open android     # ejecutar en el Android desde Android Studio
```

(Las versiones están elegidas con ≥ 2 semanas de antigüedad, igual que la política de dependencias del repo.)

Dentro de la app, además del protocolo de arriba (repetirlo completo en PixiJS y Phaser):

- **Segundo plano / contexto WebGL:** mandar la app a segundo plano 10 s y también ~2 min, volver; abrir otras apps
  pesadas (cámara, juego) entre medio para forzar presión de memoria. Anotar «reanudó», «Context lost while hidden» y
  si la WebView se recargó.
- **Notificación local:** en `index.html` aparece la tarjeta «Capacitor». «Notificación local (+15 s)» → aceptar
  permiso → mandar la app a segundo plano → debe llegar la notificación. Probar también con la app cerrada.
- **IAP sandbox (RevenueCat):** crear un producto de prueba en App Store Connect / Play Console, configurarlo en
  RevenueCat (offering «current»), usar un usuario sandbox (iOS) o tester con licencia (Android). «Compra sandbox» pide
  la clave pública de RevenueCat y compra el primer paquete; el resultado queda en el log de la tarjeta.
- **Audio:** «Probar audio» dentro de la app (estado antes/después del toque).
- **Tamaño:** anotar el tamaño de la app instalada (Ajustes → Almacenamiento) en ambos sistemas.

Copiar el log de la tarjeta Capacitor junto con los resultados al issue.

---

## Technical notes (English)

**Layout.** `src/scene/types.ts` defines the `SceneRenderer` seam (`mount`, `loadScene`, `transitionTo`, `playHit`,
`playAttack`, `tap`, `stats`, `samplePixel`, `destroy`). `src/scene/model.ts` holds the renderer-agnostic scene
state: tweens (bob, lunge, shake, flash, death fade, respawn), particle physics, hotspot pulses and a seeded attack
choreography. `src/renderers/base.ts` implements the shared parts; `pixi.ts` and `phaser.ts` only load/unload
textures, create display objects and copy the model into them each frame. Both renderers therefore run *identical*
animation logic: the comparison measures rendering cost, not two animation implementations. Phaser's own tween,
particle, input and scene-graph-for-gameplay features are intentionally unused (the production client would keep game
state in React/server data anyway, ADR-0010).

**Fairness settings.** Both use WebGL (Pixi `preference: 'webgl'`; Phaser `type: WEBGL`), no MSAA, linear texture
filtering, and the same backing-store size (CSS size × `resolution`; Phaser via `Scale.NONE` + `zoom = 1/resolution`).
Input is handled once on the DOM element by the harness for both. One scene's textures are resident at a time:
textures not used by the next scene are released *before* loading it.

**Metrics.** Frame times come from a harness-owned `requestAnimationFrame` loop (same code for both). "1 % low" =
1000 / mean of the slowest 1 % frame times. "Load → first frame" is `performance.now()` (navigation-relative) after the
first rendered frame, so it includes HTML/JS download, parse, renderer init and texture decode. Texture memory is an
uncompressed RGBA estimate (w×h×4, no mipmaps); the framebuffer estimate is w×h×4×2. Real GPU/process memory must be
read from Xcode Instruments / Safari Web Inspector (iOS) or `chrome://inspect` + Android Studio profiler. JS heap
comes from `performance.memory` (Chromium only). "JS transferred" uses Resource Timing; "JS bundle" comes from
`build-info.json` emitted at build time (all chunks reachable from the page entry, including lazily loaded ones).
"Scene images" is the encoded size of the first scene's textures from the manifest.

**Context-loss test.** Samples three background pixels via `gl.readPixels` on the default framebuffer right after a
real engine render, forces `WEBGL_lose_context.loseContext()`, waits 1 s, calls `restoreContext()`, waits for a
rendered frame and re-samples. PASS = rendering resumed and the pixels match (textures re-uploaded). Real background
losses are counted separately via `webglcontextlost` events.

**Assets.** `scripts/gen-assets.ts` paints the art procedurally (pure TS rasteriser in `src/art/`) and writes PNG
(`node:zlib`) and lossy WebP q80 (`@jsquash/webp`, WASM) plus `manifest.json` into `public/generated/` (git-ignored;
regenerated only when the generator version changes). Procedural art compresses unusually well as WebP (≈ 50–70 KiB
vs ≈ 1.1–1.6 MiB PNG for the backgrounds); painted art will be larger, so download sizes are indicative only — decode
time and GPU memory (which are format-independent once decoded) are the relevant numbers.

**Not covered: KTX2/Basis.** Producing KTX2 needs the `basisu` encoder (native binary or a large WASM build) and a
transcoder in each renderer (Pixi `@pixi/ktx2`-style loader; Phaser's compressed-texture loader expects
pre-transcoded per-platform files). That is not trivial to add reliably here, so compressed textures are **not**
measured by this kit; the `compressedFormats` device field (ASTC/ETC/S3TC/…) at least records what each phone supports.
A follow-up can add a KTX2 variant if the uncompressed numbers show texture memory is the bottleneck.

**Static hosting.** `vite build` uses `base: './'`; `dist/` can be served from any path (sub-folder, Capacitor
`webDir`). Pages: `index.html`, `pixi.html`, `phaser.html`; assets under `assets/` and `generated/`;
`build-info.json` for bundle sizes.

Commands: `pnpm --filter @spikes/render-mobile dev|build|preview|typecheck|assets` (`assets -- --force` regenerates).
