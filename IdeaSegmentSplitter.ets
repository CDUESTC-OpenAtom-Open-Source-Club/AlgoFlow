import { IdeaSegment } from './Models';

/**
 * 思路片段拆分器（纯领域逻辑，可单测）。
 *
 * 将思路文本按行拆分为稳定的 IdeaSegment：
 *  - 以换行符拆分为非空行；
 *  - 优先复用已有片段 id（位置 + 内容均匹配），否则分配新 id；
 *  - 保证同一草稿内片段 id 稳定，供 AI 的 source_refs 引用。
 */
export class IdeaSegmentSplitter {
  static split(text: string, draftId: string, clientId: string, existing: IdeaSegment[]): IdeaSegment[] {
    const lines: string[] = text.split('\n');
    const usedIds: string[] = [];
    const result: IdeaSegment[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const reused = IdeaSegmentSplitter.findReusable(existing, i, trimmed, usedIds);
      if (reused !== undefined) {
        usedIds.push(reused.id);
        result.push(new IdeaSegment(reused.id, draftId, i, trimmed, clientId));
      } else {
        const freshId = IdeaSegmentSplitter.nextId(draftId, usedIds);
        usedIds.push(freshId);
        result.push(new IdeaSegment(freshId, draftId, i, trimmed, clientId));
      }
    }
    return result;
  }

  private static findReusable(existing: IdeaSegment[], position: number, content: string, usedIds: string[]): IdeaSegment | undefined {
    for (let i = 0; i < existing.length; i++) {
      const seg = existing[i];
      if (seg.position === position && seg.content === content && usedIds.indexOf(seg.id) < 0) {
        return seg;
      }
    }
    return undefined;
  }

  private static nextId(draftId: string, usedIds: string[]): string {
    let index = 1;
    while (true) {
      const candidate = `idea_segment_${draftId}_${index}`;
      if (usedIds.indexOf(candidate) < 0) {
        return candidate;
      }
      index++;
    }
  }
}
