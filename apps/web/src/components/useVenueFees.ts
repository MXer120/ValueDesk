/**
 * Both engines' `/fee-rate`, kept apart.
 *
 * The order ticket and the fee schedule need spot and perps together: each
 * engine has its own volume tier and its own maker-rebate tier, and the staking
 * tier is read from both rather than collapsed. `useAsync` would keep the
 * previous account's body on screen until the next response landed, which is a
 * wrong "You" row, so a fresh address clears the rates before the fetch returns.
 */
import { useEffect, useState } from 'react';
import { api, type Engine } from '../api';
import { readVenueFee, type VenueFeeRead } from '../fees';

export interface VenueFees {
  spot: VenueFeeRead | null;
  perps: VenueFeeRead | null;
  loading: boolean;
  /** Request failed. A null rate with a null error means the body had no rates. */
  spotError: string | null;
  perpsError: string | null;
}

function useEngineFee(engine: Engine, address: string | null | undefined, enabled: boolean) {
  const [rate, setRate] = useState<VenueFeeRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !address) {
      setRate(null);
      setLoading(false);
      setError(null);
      return;
    }
    let dead = false;
    setRate(null);
    setError(null);
    setLoading(true);
    api.feeRate(engine, address)
      .then((body) => {
        if (dead) return;
        setRate(readVenueFee(body));
      })
      .catch((e: unknown) => {
        if (dead) return;
        setRate(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [engine, address, enabled]);

  return { rate, loading, error };
}

export function useVenueFees(address: string | null | undefined, enabled = true): VenueFees {
  const spot = useEngineFee('spot', address, enabled);
  const perps = useEngineFee('perps', address, enabled);
  return {
    spot: spot.rate,
    perps: perps.rate,
    loading: spot.loading || perps.loading,
    spotError: spot.error,
    perpsError: perps.error,
  };
}
