/**
 * A wallet's Blind Boxes, view only. `WalletBoxesView` is what the chain says: the count, and the ids and
 * tiers when they add up exactly (blindBox.ts readWalletBoxes). `ProgressPanel` is what only SoDEX's
 * sign-in can read, behind SODEX_SIGNIN_LIVE. Opening and merging stay on SoDEX's own page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, Group, Row } from '../portfolio/parts';
import { EmptyState, NoWallet } from '../EmptyState';
import { usePolled } from '../explore/cohorts/parts';
import {
  LEVELS, LEVEL_LABEL, createBlindBoxReads, readWalletBoxes, valuechainRpc,
  type DrawAnswer, type HistoryAnswer, type ProgressAnswer, type WalletBoxes,
} from '../../blindBox';
import { DASH, fmt, fmtUsd } from '../../format';
import { getPointsToken } from '../../points';
import { SODEX_SITE } from '../../sodexProgrammes';
import { BoxArt } from './BoxArt';
import { Pill, ReadFailed, SkelRows, fmtDate, fmtTokens } from './parts';

/** How many ids a tier prints before it folds. */
const IDS_SHOWN = 24;

export const OpenOnSodex = () => (
  <a className="pf-btn" href={SODEX_SITE.blindBox} target="_blank" rel="noopener noreferrer">Open on SoDEX</a>
);

export function OnChainBoxes({ address, box }: { address: string | null; box: string | undefined }) {
  const read = usePolled(
    address && box ? `boxes:${address.toLowerCase()}:${box}` : null,
    (signal) => readWalletBoxes(address as string, box as string, valuechainRpc(signal)),
    60_000,
  );
  return (
    <Card title="Your boxes" action={<OpenOnSodex />}>
      {!address ? <NoWallet line="Connect a wallet to see the boxes it holds." compact />
        : !box ? <p className="pf-note">{DASH}</p>
          : read.error && !read.data ? <ReadFailed what="Your boxes" error={read.error} onRetry={read.retry} />
            : !read.data ? <SkelRows rows={2} height={72} />
              : <WalletBoxesView boxes={read.data} />}
    </Card>
  );
}

export function WalletBoxesView({ boxes }: { boxes: WalletBoxes }) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  if (boxes.count === 0) {
    return <EmptyState icon="coins" title="No boxes in this wallet" line="Boxes it holds on ValueChain show here." compact />;
  }
  return (
    <>
      <div className="sdx-boxcount">
        <b>{fmt(boxes.count, 0)}</b>
        <span>{boxes.count === 1 ? 'box' : 'boxes'} in this wallet, unopened</span>
      </div>
      {boxes.exact ? (
        <>
          <div className="sdx-boxlevels">
            {LEVELS.map((level) => (
              <div key={level} className="sdx-boxlevel">
                <BoxArt level={level} size={34} />
                <span>{LEVEL_LABEL[level]}</span>
                <b>{fmt(boxes.byLevel[level].length, 0)}</b>
              </div>
            ))}
          </div>
          {LEVELS.filter((l) => boxes.byLevel[l].length > 0).map((level) => {
            const ids = boxes.byLevel[level];
            const open = unfolded.has(level);
            const shown = open ? ids : ids.slice(0, IDS_SHOWN);
            return (
              <section key={level} className="sdx-shelf">
                <header>
                  <b>{LEVEL_LABEL[level]}</b>
                  <span className="sdx-shelf__count">{ids.length}</span>
                </header>
                <ul className="sdx-tokens">
                  {shown.map((id) => <li key={id}><span className="sdx-token">#{id}</span></li>)}
                  {ids.length > IDS_SHOWN && (
                    <li>
                      <button type="button" className="sdx-token" onClick={() => setUnfolded((s) => new Set(s).add(level))} hidden={open}>
                        +{ids.length - IDS_SHOWN} more
                      </button>
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </>
      ) : (
        <p className="pf-note">The tiers could not be read just now, so only the count is shown.</p>
      )}
    </>
  );
}

/* --- behind SODEX_SIGNIN_LIVE ------------------------------------------------------------------- */

interface PanelData { progress: ProgressAnswer | null; history: HistoryAnswer | null; draw: DrawAnswer | null }

export function ProgressPanel({ address }: { address: string | null }) {
  const client = useMemo(() => createBlindBoxReads({ fetchImpl: (...a) => fetch(...a), token: () => getPointsToken(address) || null }), [address]);
  const [data, setData] = useState<PanelData>({ progress: null, history: null, draw: null });
  useEffect(() => {
    let off = false;
    void Promise.allSettled([client.progress(), client.history(), client.drawEntries()]).then(([p, h, d]) => {
      if (off) return;
      setData({
        progress: p.status === 'fulfilled' ? p.value : null,
        history: h.status === 'fulfilled' ? h.value : null,
        draw: d.status === 'fulfilled' ? d.value : null,
      });
    });
    return () => { off = true; };
  }, [client]);
  return <ProgressView {...data} />;
}

export function ProgressView({ progress, history, draw }: PanelData) {
  return (
    <Card title="Your progress" action={<OpenOnSodex />}>
      <div className="sdx-vaulthead">
        <Group title="Next box">
          <Row label="Effective volume" value={progress?.effectiveU == null ? DASH : fmtUsd(progress.effectiveU, 2)} />
          <Row label="To the next box" value={progress?.toNextBoxU == null ? DASH : fmtUsd(progress.toNextBoxU, 2)} />
          <Row label="Boxes earned" value={progress?.boxesEarned == null ? DASH : fmt(progress.boxesEarned, 0)} />
        </Group>
        <Group title="Weekly draw">
          <Row label="Round" value={draw?.round == null ? DASH : String(draw.round)} />
          <Row label="Tickets" value={draw?.tickets == null ? DASH : fmt(draw.tickets, 0)} />
          <Row label="Wins" value={draw?.wins == null ? DASH : fmt(draw.wins, 0)} />
        </Group>
      </div>
      {!!history?.items.length && (
        <ul className="sdx-feed">
          {history.items.map((h, i) => (
            <li key={String(h.requestId ?? i) + String(h.tokenId)} className="sdx-feed__row">
              <BoxArt level={h.level ?? 'Common'} size={30} />
              <div className="sdx-feed__who">
                <b>#{String(h.tokenId ?? DASH)}</b>
                <small>{h.level ?? DASH}{h.settledAt ? ` · ${fmtDate(Date.parse(h.settledAt))}` : ''}</small>
              </div>
              {h.pfpTokenId != null && <Pill tone="info">PFP #{String(h.pfpTokenId)}</Pill>}
              <div className="sdx-feed__prize">
                <b>{h.rewardUsd ? fmtUsd(h.rewardUsd, 2) : DASH}</b>
                <small>{h.reward?.amount && h.reward.asset?.symbol ? `${fmtTokens(h.reward.amount)} ${h.reward.asset.symbol}` : DASH}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
