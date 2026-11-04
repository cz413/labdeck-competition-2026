import {it,expect} from 'vitest'
import {matchesTaskStatus,toggleTaskStatus} from './experiment-pool-filter'
it('filters failed, completed and planned tasks independently',()=>{
  expect(matchesTaskStatus('failed','failed')).toBe(true)
  expect(matchesTaskStatus('completed','failed')).toBe(false)
  expect(matchesTaskStatus('planned','planned')).toBe(true)
})
it('includes all active stages and toggles a selected statistic back to all',()=>{
  for(const status of ['queued','preparing','running','paused'] as const)expect(matchesTaskStatus(status,'active')).toBe(true)
  expect(matchesTaskStatus('failed','active')).toBe(false)
  expect(toggleTaskStatus('failed','failed')).toBe('all')
  expect(toggleTaskStatus('failed','active')).toBe('active')
  expect(matchesTaskStatus('cancelled','all')).toBe(true)
})
