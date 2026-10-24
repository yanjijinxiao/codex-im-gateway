/** Transport-independent permission choices. Copying is never a decision. */
export const IDE_APPROVAL_CHOICES = [
  { label: "批准并信任此目录", choice: "trust", style: "primary", detail: "允许编辑和终端，并启用此目录的任务、调试及扩展。" },
  { label: "仅批准访问", choice: "access", style: "default", detail: "允许编辑和终端，不自动信任目录中的代码。" },
  { label: "拒绝", choice: "deny", style: "danger", detail: "拒绝此浏览器申请，不签发访问授权。" }
] as const;
export const ideConfirmationCommand = (code: string, choice: typeof IDE_APPROVAL_CHOICES[number]["choice"]) => `/ide ${choice} ${code}`;
