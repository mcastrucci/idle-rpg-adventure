import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { InventorySnapshotDto, MerchantCatalogDto } from '@rpg/protocol';
import type { ApiClient } from '../../api/http.ts';
import { t } from '../../i18n/index.ts';
import { getInventory, getMerchantCatalog } from '../../inventory/api.ts';
import type { InventoryTab } from '../InventoryScreen.tsx';

interface Input {
  readonly actorId: string | null;
  readonly tab: InventoryTab;
  readonly api: ApiClient;
  readonly setSnapshot: Dispatch<SetStateAction<InventorySnapshotDto | null>>;
  readonly setMerchant: Dispatch<SetStateAction<MerchantCatalogDto | null>>;
  readonly setReadError: Dispatch<SetStateAction<string | null>>;
  readonly setMerchantError: Dispatch<SetStateAction<string | null>>;
}

export function useInventoryState({ actorId, tab, api, setSnapshot, setMerchant, setReadError, setMerchantError }: Input) {
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [merchantLoading, setMerchantLoading] = useState(false);
  const readGeneration = useRef(0);
  const merchantGeneration = useRef(0);

  const reloadInventory = useCallback(async () => {
    const generation = ++readGeneration.current;
    const requestedActor = actorId;
    if (!requestedActor) { setSnapshot(null); setReadError(null); return; }
    setInventoryLoading(true); setReadError(null);
    try {
      const value = await getInventory(api, requestedActor);
      if (generation === readGeneration.current && requestedActor === actorId && value.actorId === requestedActor) setSnapshot(value);
      else if (value.actorId !== requestedActor) throw new Error('actor_mismatch');
    } catch (error) {
      if (generation === readGeneration.current && requestedActor === actorId) { setSnapshot(null); setReadError(errorLabel(error)); }
      throw error;
    } finally {
      if (generation === readGeneration.current && requestedActor === actorId) setInventoryLoading(false);
    }
  }, [actorId, api, setReadError, setSnapshot]);

  const reloadMerchant = useCallback(async () => {
    const generation = ++merchantGeneration.current;
    setMerchantLoading(true); setMerchantError(null);
    try {
      const value = await getMerchantCatalog(api);
      if (generation === merchantGeneration.current) setMerchant(value);
    } catch (error) {
      if (generation === merchantGeneration.current) { setMerchant(null); setMerchantError(errorLabel(error)); }
      throw error;
    } finally { if (generation === merchantGeneration.current) setMerchantLoading(false); }
  }, [api, setMerchant, setMerchantError]);

  useEffect(() => { setSnapshot(null); setReadError(null); void reloadInventory().catch(() => undefined); }, [actorId, reloadInventory, setReadError, setSnapshot]);
  useEffect(() => { if (tab === 'merchant') void reloadMerchant().catch(() => undefined); }, [tab, reloadMerchant]);
  useEffect(() => () => { readGeneration.current++; merchantGeneration.current++; }, []);

  return { inventoryLoading, merchantLoading, reloadInventory, reloadMerchant };
}

function errorLabel(error: unknown): string { return error instanceof Error ? error.message : t('ui.common.unknown_error'); }
