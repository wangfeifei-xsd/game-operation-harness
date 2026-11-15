/** 默认保存失败反馈由应用层持有，关闭选择菜单后仍可见。 */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** 应用层反馈的状态与关闭动作。 */
export interface DefaultModelToastFace {
  hooks: { failure: HostObservable<number | null> }
  dismiss: () => void
}

/**
 * 告知当前会话已切换、默认配置未保存，并提供下一步操作。
 * @param props - 应用层状态、关闭动作与模型选择字典。
 * @returns 当前提示；没有失败时返回空。
 */
export function DefaultModelToast({ useFailure, dismiss, t }: PropsRuntime<'shell.overlay'>
  & PropsLocale<'model'> & InjectFace<DefaultModelToastFace>): ReactNode {
  const failure = useFailure(value => value)
  return failure === null ? null
    : <Toast key={failure} text={t('error.defaultSave')} icon={<IconWarningOutlineRegular />} onDone={dismiss} />
}
