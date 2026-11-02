/** Device / browser / GPU information for the report. */

export type DeviceInfo = Record<string, string | number | boolean | null>;

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function shell(): string {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (cap?.isNativePlatform?.()) return `capacitor-${cap.getPlatform?.() ?? 'native'}`;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return 'standalone';
  return 'browser';
}

export function collectDeviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const info: DeviceInfo = {
    userAgent: navigator.userAgent,
    platform: navigator.platform || null,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    shell: shell(),
    webglVersion: null,
    gpuVendor: null,
    gpuRenderer: null,
    maxTextureSize: null,
    compressedFormats: null,
  };
  const canvas = document.createElement('canvas');
  const gl2 = canvas.getContext('webgl2');
  const gl = gl2 ?? canvas.getContext('webgl');
  if (!gl) return info;
  info['webglVersion'] = gl2 ? 'WebGL2' : 'WebGL1';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  info['gpuVendor'] = String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
  info['gpuRenderer'] = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  info['maxTextureSize'] = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  info['compressedFormats'] =
    ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_s3tc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_pvrtc']
      .filter((e) => gl.getExtension(e) !== null)
      .map((e) => e.replace(/^(WEBGL|EXT)_(compressed_)?texture_(compression_)?/, ''))
      .join(',') || 'none';
  // Free the probe context right away (iOS limits live contexts).
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return info;
}
