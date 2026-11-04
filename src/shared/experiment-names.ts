import type { ExperimentTaskDraft } from './types'
export function preparationTaskNames(draft:ExperimentTaskDraft,root:string,preserveTitle=false):ExperimentTaskDraft {
  const repository=draft.project.trim()||root.split('/').filter(Boolean).at(-1)||'新实验'
  const runTitle=(draft.runTitle?.trim()||(draft.title!==repository?draft.title:draft.objective)||'本次运行').slice(0,160)
  return {...draft,title:preserveTitle?draft.title:repository.slice(0,160),runTitle}
}
