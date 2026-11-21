import { Card, Space, Typography } from 'antd'

/** 业务页已完成账号授权，此处只显示本机配对码。 */
export function BusinessAccess({ pairCode }: { pairCode: string | null }) {
  return <Card title="连接本机助手">
    <Space orientation="vertical">
      <Typography.Text>打开本机 Agent 助手，选择「连接业务助手」，输入配对码并选择工作区。</Typography.Text>
      {pairCode && <Typography.Title level={2} copyable style={{ margin: 0, letterSpacing: 3 }}>{pairCode}</Typography.Title>}
    </Space>
  </Card>
}
