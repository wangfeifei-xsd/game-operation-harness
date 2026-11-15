/** 直接模型配置页面的类型化文案。 */
export const en = {
  checkTimeFormat: '{year}年{month}月{day}日 {hour}:{minute}:{second}',
  reloadDraft: 'Reload saved values and discard this draft?', removed: 'This model was deleted. Add a new configuration to continue.',
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
  nav: 'Models', title: 'Model configuration', settings: 'Settings', add: 'Add model', edit: 'Edit', test: 'Test connection', default: 'Default', setDefault: 'Set as default', enable: 'Enable', disable: 'Disable', remove: 'Delete',
  name: 'Model name', provider: 'Provider', model: 'Model identifier', enabled: 'Enabled', disabled: 'Disabled', state: 'Status', actions: 'Actions', baseUrl: 'API base URL', key: 'API key', keyConfigured: 'Configured; leave blank to keep',
  advanced: 'Advanced settings', protocol: 'Protocol', timeout: 'Request timeout (seconds)', context: 'Context limit (tokens)', output: 'Maximum output tokens', images: 'Image input', reasoning: 'Reasoning effort', providerDefault: 'Provider default',
  save: 'Save', cancel: 'Cancel', empty: 'No models configured', required: 'This field is required', retry: 'Retry', loadFailed: 'Could not load models', failed: 'Operation failed', confirmRemove: 'Delete this model?', confirmDisable: 'Disable this model?', replacement: 'Replacement default model',
  discard: 'Discard unsaved changes?', confirm: 'Confirm', changeProvider: 'Replace the edited URL with the new provider default?', cleanup: 'Saved; some old credentials could not be removed. Restart to retry.', reload: 'Reload',
  connected: 'Connection succeeded', unsupported: 'This endpoint does not support a model directory check', stale: 'Configuration changed; run the check again', checkedAt: 'Checked at', duration: 'Duration (ms)', conflict: 'Configuration changed in another window. Reload before saving.', other: 'Other',
  completions: 'Chat Completions', responses: 'Responses', messages: 'Messages', generate: 'generateContent', unavailable: 'Credential missing',
}
/** 模型配置文案的受检键。 */
export type DirectModelKey = keyof typeof en
/** 模型配置的中文文案。 */
export const zh: Record<DirectModelKey, string> = {
  checkTimeFormat: '{year}年{month}月{day}日 {hour}:{minute}:{second}',
  reloadDraft: '重新加载已保存的配置并放弃当前草稿？', removed: '此模型已被删除，请重新新增配置',
  off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
  nav: '模型', title: '模型配置', settings: '设置', add: '新增模型', edit: '编辑', test: '测试连接', default: '默认', setDefault: '设为默认', enable: '启用', disable: '停用', remove: '删除',
  name: '模型名称', provider: '供应商', model: '模型标识', enabled: '已启用', disabled: '已停用', state: '状态', actions: '操作', baseUrl: '接口地址', key: 'API Key', keyConfigured: '已配置，留空保留原值',
  advanced: '高级设置', protocol: '协议', timeout: '请求超时（秒）', context: '上下文上限（Token）', output: '最大输出 Token 数', images: '图片输入', reasoning: '推理强度', providerDefault: '供应商默认',
  save: '保存', cancel: '取消', empty: '尚未配置模型', required: '请填写此字段', retry: '重试', loadFailed: '模型配置加载失败', failed: '操作失败', confirmRemove: '删除此模型？', confirmDisable: '停用此模型？', replacement: '替代默认模型',
  discard: '放弃未保存的修改？', confirm: '确定', changeProvider: '使用新供应商的默认地址覆盖已修改的地址？', cleanup: '配置已保存，部分旧凭据未清理，重启后将重试。', reload: '重新加载',
  connected: '连接成功', unsupported: '供应商不支持模型目录检查', stale: '配置已变化，请重新检查', checkedAt: '检查时间', duration: '耗时（毫秒）', conflict: '配置已被其他窗口修改，请重新加载后保存。', other: '其他',
  completions: 'Chat Completions', responses: 'Responses', messages: 'Messages', generate: 'generateContent', unavailable: '密钥缺失',
}
