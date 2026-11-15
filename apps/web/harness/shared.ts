/** Web 入口持有自己的同源传输。 */
import { createWebAuthTransport } from '@deepseek-ai/dsh-client-ui-harness-account'
export { copy, errorText, type LocalSession } from '@deepseek-ai/dsh-client-ui-harness-account'
const transport = createWebAuthTransport()
export const api = transport.request.bind(transport)
