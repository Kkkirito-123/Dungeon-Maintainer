/**
 * 审计日志和模型工具输出的统一脱敏规则。
 *
 * 本模块只处理即将进入事件日志、检查日志或模型上下文的短文本，不替代路径权限。
 * API Key、Bearer、SQL 正文及完整游戏状态字段会被保守移除。补丁正文使用
 * containsPrivateText 做拒绝式校验，避免把敏感内容静默改写后写回源代码。
 */

const PRIVATE_FIELD =
  /\b(?:adminAnswerSql|answerSql|referenceSql|mazeFloor|discoveredCells|runSeed|runInstanceId|profile|inventory)\b/iu;
const SQL_START =
  /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b/iu;
const KEY_TEST =
  /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/iu;
const KEY =
  /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/giu;

/**
 * 判断补丁文本是否包含不允许模型生成或回放的正文。
 *
 * @param value 补丁中的旧文本或新文本。
 * @returns 是否命中凭据、SQL 或完整游戏状态字段。
 */
export function containsPrivateText(value: string): boolean {
  return SQL_START.test(value) || PRIVATE_FIELD.test(value) || KEY_TEST.test(value);
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
    if (SQL_START.test(line)) sqlBlock = true;
    if (!sqlBlock) return line;
    const end = /[;\x60]/u.test(line) || line.trim() === "";
    if (end) sqlBlock = false;
    return "[SQL REDACTED]";
  }).join("\n");
}
