import { useEffect, useRef, useState } from 'react'
import type { MetricsSummaryView } from '../../../shared/domain/views'
import { runCommand } from '../api/dm'
import { createScoreReader, type ScoreReader, type ScoreReadState, shownState } from '../scorecard/scoreReads'

interface MetricsReadState {
  state: ScoreReadState<MetricsSummaryView>
  /** A Refresh (or Try again) is in flight. */
  refreshing: boolean
}

/**
 * The folder's live metrics summary (no `until`: as of now; no `since`: every epic), read once when the dashboard opens
 * and again only when `version` changes (Refresh): the summary is computed synchronously in the main process and grows
 * with the runs, so it is never polled. It names its runs and tickets itself, so it is the only read. A failed refresh
 * keeps the data it read beside the error; a read for a folder no longer shown is dropped.
 */
export function useMetricsRead(folder: string, version: number): MetricsReadState {
  const [state, setState] = useState<ScoreReadState<MetricsSummaryView>>({ status: 'idle' })
  const [refreshing, setRefreshing] = useState(false)
  const reader = useRef<ScoreReader<MetricsSummaryView> | null>(null)
  reader.current ??= createScoreReader<MetricsSummaryView>({ onChange: setState, now: Date.now })

  useEffect(() => {
    void reader.current?.select(folder, () => runCommand(folder, 'getMetricsSummary', {}))
  }, [folder])

  // The first render's version is read by the selection above; only a change asks again.
  const readVersion = useRef(version)
  useEffect(() => {
    if (readVersion.current === version) {
      return
    }
    readVersion.current = version
    setRefreshing(true)
    void reader.current?.refresh().finally(() => setRefreshing(false))
  }, [version])

  return { state: shownState(state, folder), refreshing }
}
