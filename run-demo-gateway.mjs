// 仅用于联调验证，不是产品代码。放到 AlgoFlow 仓库根目录执行：
//   PROVIDER=ok      node run-demo-gateway.mjs   # 返回合法 artifact（伪代码步骤 1:1 映射到请求里的 idea_segments）
//   PROVIDER=violate node run-demo-gateway.mjs   # 返回越界 artifact（added_algorithm_steps 非空）→ 手机应显示“AI 产物越界，已拒绝”
//   PROVIDER=slow    node run-demo-gateway.mjs   # 20s 后才返回 → 用来测手机端 10s 读超时 / 取消
//   PROVIDER=error   node run-demo-gateway.mjs   # provider 抛异常 → 502 AI_PROVIDER_ERROR，手机应重试 2 次后报错
//   PROVIDER=none    node run-demo-gateway.mjs   # 不配置 provider → 503 AI_NOT_ENABLED
// 监听 0.0.0.0:8788，手机端 AI 面板里的地址填 http://<电脑局域网IP>:8788
import { createAIGateway } from './services/ai-gateway/src/server.mjs';

const mode = process.env.PROVIDER ?? 'ok';

// output_kind=code_snippet：每个思路片段回显成一行占位调用，step_N 映射到第 N 行，用于复写对比联调。
function buildArtifact(request, violate) {
  const snippet = request.output_kind === 'code_snippet';
  return {
    mode: request.mode,
    pseudocode: request.idea_segments.map((seg, i) => ({
      id: `step_${i + 1}`,
      step: `[demo] ${seg.content}`,
      source_refs: [seg.id]
    })),
    code_snippet: snippet ? request.idea_segments.map((seg, i) => `step_${i + 1}();  // ${seg.content}`).join('\n') : null,
    code_mappings: snippet ? request.idea_segments.map((_, i) => ({ step_id: `step_${i + 1}`, start_line: i + 1, end_line: i + 1 })) : [],
    assumptions: ['demo provider：仅回显思路，不做真实推理'],
    missing_information: [],
    risk_flags: snippet ? ['demo provider：未检查空输入和端点相等的边界'] : [],
    added_algorithm_steps: violate ? ['（越界）改用动态规划'] : [],
    source_draft_version: request.draft_version,
    model_id: 'demo-provider',
    rule_version: request.rule_version,
    output_kind: request.output_kind,
    visibility: request.visibility,
    template_id: null
  };
}

const providers = {
  ok: { async generate({ request }) { return buildArtifact(request, false); } },
  violate: { async generate({ request }) { return buildArtifact(request, true); } },
  slow: { async generate({ request }) { await new Promise((r) => setTimeout(r, 20000)); return buildArtifact(request, false); } },
  error: { async generate() { throw new Error('demo provider failure'); } },
  none: null
};

if (!(mode in providers)) { console.error(`unknown PROVIDER=${mode}`); process.exit(1); }

const server = createAIGateway({ aiProvider: providers[mode] });
server.on('request', (req) => console.log(new Date().toISOString(), req.method, req.url));
server.listen(8788, '0.0.0.0', () => console.log(`[demo] AI gateway PROVIDER=${mode} listening on 0.0.0.0:8788`));
