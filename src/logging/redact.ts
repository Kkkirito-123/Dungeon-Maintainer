/**
 * 审计日志和模型工具输出的统一脱敏规则。
 *
 * 本模块只处理即将进入事件日志、检查日志或模型上下文的短文本，不替代路径权限。
 * API Key、Bearer、SQL 正文及完整游戏状态字段会从日志中保守移除。Coding Agent
 * 读取和修改源码时只拒绝真实凭据；题目 SQL 和答案定义属于需要诊断的项目源码。
 */

const PRIVATE_FIELD =
  /\b(?:adminAnswerSql|answerSql|referenceSql|mazeFloor|discoveredCells|runSeed|runInstanceId|profile|inventory)\b/iu;
const SQL_START =
  /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b/iu;
const KEY_TEST =
  /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/iu;
const KEY =
  /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/giu;
const SQL_LINE_START =
  /^\s*(?:(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b|(?:sql|query)\s*[:=]\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b)/iu;

/**
 * 判断补丁文本是否包含不允许模型生成或回放的正文。
 *
 * @param value 补丁中的旧文本或新文本。
 * @returns 是否命中凭据、SQL 或完整游戏状态字段。
 */
export function containsPrivateText(value: string): boolean {
  return SQL_START.test(value) || PRIVATE_FIELD.test(value) || KEY_TEST.test(value);
}

/** 判断源码片段是否包含不能进入模型或补丁的真实凭据。 */
export function containsCredentialText(value: string): boolean {
  return KEY_TEST.test(value);
}

/** 仅移除凭据，保留 Coding Agent 诊断所需的项目源码。 */
export function redactCredentials(value: string): string {
  return value.replace(KEY, "[CREDENTIAL REDACTED]");
}

/**
 * 脱敏即将进入日志或模型上下文的文本。
 *
 * @param value 任意外部命令输出、浏览器错误或用户可见摘要。
 * @returns 保留基本换行结构的安全文本。
 */
export function redactText(value: string): string {
  let output = value.replace(KEY, "[CREDENTIAL REDACTED]");
  output = output.replace(
    /\x60\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b[\s\S]*?\x60/giu,
    "[SQL REDACTED]",
  );
  output = output.replace(
    /(["'])\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b[^\r\n]*?\1/giu,
    "$1[SQL REDACTED]$1",
  );
  let sqlBlock = false;
  return output.split(/\r?\n/u).map((line) => {
    if (PRIVATE_FIELD.test(line)) return "[PRIVATE GAME STATE REDACTED]";
    // 只有语句位于行首（或明确的 sql/query 字段）才进入多行 SQL 脱敏。
    // 自然语言中的“SELECT 战斗”“UPDATE 任务”不能吞掉整条用户请求，否则会丢失
    // 修复意图并让 Extension 把真正的修复请求误判成普通问答。
    if (SQL_LINE_START.test(line)) sqlBlock = true;
    if (!sqlBlock) return line;
    const end = /[;\x60]/u.test(line) || line.trim() === "";
    if (end) sqlBlock = false;
    return "[SQL REDACTED]";
  }).join("\n");
}
