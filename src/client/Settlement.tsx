import { useState } from 'react'
import type { PlayerView } from '../types.ts'
import { t } from './i18n.ts'
import { createRoom, leaveRoom } from './store.ts'
import { copyText, cx, downloadJson, formatBb, formatChips, formatDuration, signedChips } from './ui.ts'
import css from './styles.module.css'

export function Settlement({ view }: { view: PlayerView }) {
  const summary = view.settlement
  const [copied, setCopied] = useState(false)
  if (!summary) {
    return (
      <div className={css.settle}>
        <p className={css.railEmpty}>{t('settle.empty')}</p>
        <button type="button" className={cx(css.btn, css.btnPrimary)} onClick={() => void leaveRoom()}>
          {t('common.back')}
        </button>
      </div>
    )
  }

  const isHost = view.room.hostPlayerId === view.you.playerId
  const markdown = buildMarkdown(view)
  const fileName = `holdem-${summary.roomCode}-${summary.sessionId.slice(-6)}.json`

  const again = async (): Promise<void> => {
    const title = summary.title
    const blindLevel = view.room.settings.blindLevel
    const displayName = view.you.displayName
    try {
      await leaveRoom()
      await createRoom({ title, blindLevel, displayName })
    } catch {
      // createRoom 内部已经 toast 过错误；这里只避免未捕获的 Promise rejection。
    }
  }

  return (
    <div className={css.settle}>
      <div className={css.settleHead}>
        <div>
          <h1 className={css.settleTitle}>{t('settle.title')}</h1>
          <p className={css.settleMeta}>
            {summary.reason === 'host-idle' ? t('settle.idle') : t('settle.dissolved')}
            {' · '}
            {t('settle.duration', { m: formatDuration(summary.durationMs), hands: summary.handsPlayed })}
            {' · '}
            {summary.title} #{summary.roomCode}
          </p>
        </div>
        <div className={css.settleActions}>
          <button
            type="button"
            className={cx(css.btn, css.btnGhost)}
            onClick={() => {
              void copyText(markdown).then((ok) => setCopied(ok))
            }}
          >
            {copied ? t('common.copied') : t('settle.copy')}
          </button>
          <button type="button" className={cx(css.btn, css.btnGhost)} onClick={() => downloadJson(fileName, summary)}>
            {t('settle.download')}
          </button>
          {isHost ? (
            <button type="button" className={cx(css.btn, css.btnPrimary)} onClick={() => void again()}>
              {t('settle.again')}
            </button>
          ) : null}
          <button type="button" className={cx(css.btn, isHost ? css.btnOutline : css.btnPrimary)} onClick={() => void leaveRoom()}>
            {t('settle.backHome')}
          </button>
        </div>
      </div>

      {summary.players.length === 0 ? (
        <p className={css.railEmpty}>{t('settle.empty')}</p>
      ) : (
        <div className={css.settleTable}>
          <div className={cx(css.settleRow, css.settleRowHead)}>
            <span>{t('settle.rank')}</span>
            <span>{t('settle.player')}</span>
            <span>{t('settle.hands')}</span>
            <span>{t('settle.wins')}</span>
            <span>{t('settle.net')}</span>
            <span>{t('settle.bb100')}</span>
            <span>{t('settle.showdown')}</span>
          </div>
          {summary.players.map((player) => (
            <div key={player.playerId} className={cx(css.settleRow, player.rank === 1 && css.settleRowFirst)}>
              <span className={css.settleRank}>{medal(player.rank)}</span>
              <span className={css.settlePlayer}>{player.displayName}</span>
              <span>{player.handsPlayed}</span>
              <span>{player.handsWon}</span>
              <span className={player.netChips > 0 ? css.netUp : player.netChips < 0 ? css.netDown : css.netFlat}>
                {signedChips(player.netChips)}
              </span>
              <span>{formatBb(view.room.settings.bb, player.netChips, player.handsPlayed)}</span>
              <span>
                {player.showdownsPlayed === 0
                  ? '—'
                  : `${player.showdownsWon}/${player.showdownsPlayed}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={css.settleHistory}>
        <h3 className={css.railTitle}>{t('rail.history')}</h3>
        <div className={css.historyScroll}>
          {summary.history.length === 0 ? <p className={css.railEmpty}>{t('settle.empty')}</p> : null}
          {[...summary.history].reverse().map((hand) => (
            <div key={hand.handNo} className={css.settleHandRow}>
              <span className={css.historyNo}>#{hand.handNo}</span>
              <span className={css.historyBoard}>
                {hand.board.map((card) => (
                  <span key={card} className={css.historyCard}>{card}</span>
                ))}
              </span>
              <span className={css.settleHandPot}>{formatChips(hand.pots.reduce((sum, pot) => sum + pot.amount, 0))}</span>
              <span className={css.settleHandWinners}>
                {hand.winners
                  .map((seat) => hand.deltas.find((delta) => delta.seat === seat)?.displayName ?? '')
                  .join(' · ')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function medal(rank: number): string {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return String(rank)
}

function buildMarkdown(view: PlayerView): string {
  const summary = view.settlement!
  const lines: string[] = []
  lines.push(`# 德州扑克战绩 · ${summary.roomCode}`)
  lines.push('')
  lines.push(`${summary.title} · ${summary.handsPlayed} 手 · ${new Date(summary.startedAt).toLocaleString()} → ${new Date(summary.endedAt).toLocaleString()}`)
  lines.push('')
  lines.push('| 名次 | 玩家 | 手数 | 胜局 | 净赢 | BB/100 | 摊牌 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const player of summary.players) {
    lines.push(
      `| ${player.rank} | ${player.displayName} | ${player.handsPlayed} | ${player.handsWon} | ${signedChips(player.netChips)} | ${formatBb(view.room.settings.bb, player.netChips, player.handsPlayed)} | ${player.showdownsWon}/${player.showdownsPlayed} |`,
    )
  }
  lines.push('')
  lines.push('> 娱乐筹码，与 DeepSeek 余额无关。')
  return lines.join('\n')
}
