import type { IdeaSegment } from '../types';

/** Source rail colour: three tones reused in order, by segment position. */
export function segmentTone(index: number): string {
  return `s${(index % 3) + 1}`;
}

/** Tag for the segment at `index` in the current idea segment list. */
export function SourceTag({ index, title }: { index: number; title?: string }) {
  return <span className={`seg-tag ${segmentTone(index)}`} title={title}>S{index + 1}</span>;
}

/**
 * Tag for a source_ref of an AI result. A ref that is no longer among the
 * current segments keeps its raw id and gets no rail colour.
 */
export function SourceRefTag({ refId, segments }: { refId: string; segments: IdeaSegment[] }) {
  const index = segments.findIndex((segment) => segment.id === refId);
  if (index < 0) return <span className="seg-tag unknown" title="该来源片段不在当前思路中">{refId}</span>;
  return <SourceTag index={index} title={refId} />;
}
