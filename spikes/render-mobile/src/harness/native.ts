/**
 * Capacitor-only checks (local notification, IAP sandbox via RevenueCat). The kit has no Capacitor dependency:
 * inside a Capacitor shell, installed native plugins are reachable through `window.Capacitor.Plugins`; in a browser
 * this whole section stays hidden.
 */

interface PluginMap {
  LocalNotifications?: {
    requestPermissions(): Promise<{ display: string }>;
    schedule(options: { notifications: { id: number; title: string; body: string; schedule: { at: Date } }[] }): Promise<unknown>;
  };
  Purchases?: {
    configure(options: { apiKey: string }): Promise<void>;
    getOfferings(): Promise<{ current?: { availablePackages?: { identifier: string }[] } | null }>;
    purchasePackage(options: { aPackage: unknown }): Promise<{ customerInfo?: { entitlements?: { active?: Record<string, unknown> } } }>;
  };
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: PluginMap;
}

export function capacitor(): CapacitorGlobal | null {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.isNativePlatform?.() ? cap : null;
}

export function setupNativeChecks(root: HTMLElement): void {
  const cap = capacitor();
  if (!cap) return;
  root.hidden = false;
  const log = root.querySelector<HTMLTextAreaElement>('textarea');
  const write = (line: string): void => {
    if (log) log.value += `${new Date().toISOString()} ${line}\n`;
  };
  write(`platform=${cap.getPlatform?.() ?? '?'} plugins=${Object.keys(cap.Plugins ?? {}).join(',')}`);

  root.querySelector('[data-native="notify"]')?.addEventListener('click', () => {
    void (async () => {
      const ln = cap.Plugins?.LocalNotifications;
      if (!ln) return write('LocalNotifications plugin not installed');
      try {
        const perm = await ln.requestPermissions();
        write(`notification permission: ${perm.display}`);
        const at = new Date(Date.now() + 15_000);
        await ln.schedule({ notifications: [{ id: 1201, title: 'Expedición terminada', body: 'Prueba del spike #12 (15 s).', schedule: { at } }] });
        write(`scheduled for ${at.toISOString()} — send the app to background and wait`);
      } catch (e) {
        write(`notification error: ${String(e)}`);
      }
    })();
  });

  root.querySelector('[data-native="iap"]')?.addEventListener('click', () => {
    void (async () => {
      const p = cap.Plugins?.Purchases;
      if (!p) return write('Purchases (RevenueCat) plugin not installed');
      const apiKey = window.prompt('RevenueCat public SDK key (appl_… / goog_…)');
      if (!apiKey) return;
      try {
        await p.configure({ apiKey });
        const offerings = await p.getOfferings();
        const pkgs = offerings.current?.availablePackages ?? [];
        write(`offerings: ${pkgs.map((x) => x.identifier).join(',') || 'none'}`);
        const first = pkgs[0];
        if (!first) return;
        const result = await p.purchasePackage({ aPackage: first });
        write(`purchase ok; active entitlements: ${Object.keys(result.customerInfo?.entitlements?.active ?? {}).join(',') || 'none'}`);
      } catch (e) {
        write(`IAP error/cancel: ${JSON.stringify(e)}`);
      }
    })();
  });
}
