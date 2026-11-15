/** 安装更新用例使用独立的受控产品配置及测试存储桶，禁止触达真实发布目标。 */
import './product-deployment-fixture.ts'
import { beforeEach, afterEach, vi } from 'vitest'

beforeEach(() => {
  vi.stubEnv('DOWNLOAD_TEST_COS_BUCKET', 'fixture-1250000000')
  vi.stubEnv('DSH_DESKTOP_PRODUCT_ENVIRONMENT', 'test')
  vi.stubEnv('DSH_DESKTOP_AUTO_UPDATE_ENV', 'test')
})
afterEach(() => { vi.unstubAllEnvs() })
