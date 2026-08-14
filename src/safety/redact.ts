/**
 * 模型上下文、日志与报告的统一脱敏规则。
 *
 * 本模块保守移除 API Key、Bearer、SQL 正文以及运行时地图/存档字段。它不尝试理解
 * 业务代码，也不能替代路径白名单；调用方必须先做真实路径校验，再对即将进入模型
 * 或落盘日志的文本脱敏。误伤少量包含 SQL 关键字的代码比泄露参考答案更可接受。
 * 补丁输入使用 `containsPrivateText` 直接拒绝，而不是静默改写代码。
 */

const PRIVATE_FIELD = /\b(?:adminAnswerSql|answerSql|referenceSql|mazeFloor|discoveredCells|runSeed|runInstanceId|profile|inventory)\b/iu;
const SQL_START = /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b/iu;
const KEY_TEST = /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/iu;
const KEY = /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/giu;

/**
 * 判断文本是否含不应由维护模型生成或回放的正文。
 * @param value 补丁旧文本或新文本。
 * @returns 是否包含 SQL、凭据形态或运行时敏感字段。
 */
export function containsPrivateText(value: string): boolean {
  return SQL_START.test(value) || PRIVATE_FIELD.test(value) || KEY_TEST.test(value);
}

/**
 * 脱敏即将进入模型上下文或本地日志的文本。
 * @param value 任意工具输出、检查日志或用户目标。
 * @returns 保留换行结构但移除敏感正文的 UTF-8 文本。
 */
export function redactText(value: string): string {
  let output = value.replace(KEY, "[CREDENTIAL REDACTED]");
  output = output.replace(/`\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b[\s\S]*?`/giu, "`[SQL REDACTED]`");
  output = output.replace(/(["'])\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b[^\r\n]*?\1/giu, "$1[SQL REDACTED]$1");
  const rows = output.split(/\r?\n/u);
  let sqlBlock = false;
  return rows.map((line) => {
    if (PRIVATE_FIELD.test(line)) return "[PRIVATE GAME STATE REDACTED]";
    if (SQL_START.test(line)) sqlBlock = true;
    if (sqlBlock) {
      const end = /[;`]/u.test(line) || line.trim() === "";
      if (end) sqlBlock = false;
      return "[SQL REDACTED]";
    }
    return line;
  }).join("\n");
}
