/** Web 入口拥有同源传输与页面导航。 */
import { createRoot } from 'react-dom/client'
import { AuthPage, DownloadButton } from '@deepseek-ai/dsh-client-ui-harness-account'
import { api } from './shared.ts'
import '@deepseek-ai/dsh-client-ui-harness-account/style.css'
const notice = sessionStorage.getItem('harnessLogoutNotice') ?? ''
sessionStorage.removeItem('harnessLogoutNotice')
createRoot(document.getElementById('root')!).render(<AuthPage transport={{ request: api }} notice={notice} download={<DownloadButton transport={{ request: api }} />} onAuthenticated={() => { location.replace('/') }} />)
