import type { VerifyVerdict } from './junction-state'
import type { JunctionState } from '@shared/types'

/** verify.ps1 五判定 -> 展示用 JunctionState（agents.ts 与 detect.ts 共用，避免两份映射漂移） */
export function toJunctionState(verdict: VerifyVerdict): JunctionState {
  switch (verdict) {
    case 'ok':
      return 'active'
    case 'fail-missing':
      return 'missing'
    case 'fail-wrong-target':
      return 'other-link'
    case 'merged-empty':
      return 'merged-empty'
    case 'fail-not-link':
      return 'real-dir'
  }
}
