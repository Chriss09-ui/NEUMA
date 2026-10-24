import type { Token } from "marked";
import type { MemberCard, GroupMention } from "../contracts/collaboration.mjs";
import { lexer } from "marked";
import { InputError } from "../requirements/core.mjs";

export function validateGroupMentions(content: string, value: unknown, members: Pick<MemberCard, "id" | "name">[]): GroupMention[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new InputError("成员提及格式无效");
  const selected = value.map((mention) => {
    if (!mention || typeof mention !== "object" || Array.isArray(mention)
      || Object.keys(mention).some((key) => !["memberId", "start", "end", "text"].includes(key))
      || !Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end)
      || mention.start < 0 || mention.end <= mention.start || mention.end > content.length) throw new InputError("成员提及位置无效，请重新选择");
    const member = members.find((member) => member.id === mention.memberId);
    if (!member || mention.text !== `@${member.name}` || content.slice(mention.start, mention.end) !== mention.text)
      throw new InputError("被提及成员或消息已变化，请重新选择");
    return { memberId: member.id, start: mention.start, end: mention.end, text: mention.text };
  }).sort((a, b) => a.start - b.start);
  if (selected.some((mention, index) => index > 0 && selected[index - 1]!.end > mention.start)) throw new InputError("成员提及位置重叠，请重新选择");
  // A unique placeholder preserves Markdown context while disambiguating members
  // with the same name. Code and quoted examples cannot become delivery targets.
  for (const [index, mention] of selected.entries()) {
    let name = `NEUMA_SELECTED_MEMBER_${index}`;
    while (content.includes(name)) name += "_";
    const probe = content.slice(0, mention.start) + `@${name}` + content.slice(mention.end);
    if (!groupMentionIds(probe, [{ id: mention.memberId, name }]).includes(mention.memberId))
      throw new InputError("请在消息正文中选择要提及的成员");
  }
  return selected;
}

// Only plain message text can address a member. Examples in code, links and
// quoted material must not silently turn into delivery instructions.
export function groupMentionIds(content: string, members: Pick<MemberCard, "id" | "name">[]) {
  const byName = new Map<string, Set<string>>();
  for (const member of members) {
    if (!member.name) continue;
    const ids = byName.get(member.name) ?? new Set();
    ids.add(member.id); byName.set(member.name, ids);
  }
  const names = [...byName.keys()].filter((name) => byName.get(name)!.size === 1).sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  const boundary = (value: string | undefined) => !value || /[\s,，。.!！?？:：;；、()（）\[\]【】{}<>“”"'@]/u.test(value);
  const scan = (text: string) => {
    for (let offset = text.indexOf("@"); offset !== -1; offset = text.indexOf("@", offset + 1)) {
      if (!boundary(text[offset - 1])) continue;
      const name = names.find((name) => text.startsWith(name, offset + 1) && boundary(text[offset + name.length + 1]));
      if (name) found.add([...byName.get(name)!][0]!);
    }
  };
  const visit = (tokens: Token[] | undefined) => {
    for (const token of tokens ?? []) {
      if (["code", "codespan", "link", "image", "html", "blockquote", "escape"].includes(token.type)) continue;
      if ("tokens" in token && token.tokens) visit(token.tokens);
      else if (token.type === "text") scan(token.text);
      for (const item of ("items" in token ? token.items : []) ?? []) visit(item.tokens);
      for (const cell of ("header" in token ? token.header : []) ?? []) visit(cell.tokens);
      for (const row of ("rows" in token ? token.rows : []) ?? []) for (const cell of row) visit(cell.tokens);
    }
  };
  visit(lexer(content));
  return [...found];
}
