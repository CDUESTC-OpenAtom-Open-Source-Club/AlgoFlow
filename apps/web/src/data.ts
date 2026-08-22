import type { Documents, FileId, Mode } from './types';

export const modes: Array<{ id: Mode; label: string }> = [
  { id: 'faithful_transform', label: '忠实转换' },
  { id: 'feasibility_analysis', label: '可行性' },
  { id: 'progressive_hint', label: '渐进提示' },
  { id: 'full_solution', label: '完整解题' },
];

export const fileLabels: Record<FileId, string> = {
  'main.cpp': 'C++',
  'idea.md': 'Markdown',
  'cases.txt': '样例',
};

const initialCode = `#include <algorithm>
#include <vector>
using namespace std;

// 先按右端点排序，再依次选择不冲突区间
int maxNonOverlapping(vector<pair<int, int>> intervals) {
  sort(intervals.begin(), intervals.end(),
       [](const auto& left, const auto& right) {
         return left.second < right.second;
       });

  int selected = 0;
  int lastEnd = 0;
  for (const auto& interval : intervals) {
    if (interval.first >= lastEnd) {
      ++selected;
      lastEnd = interval.second;
    }
  }
  return selected;
}`;

export const initialDocuments: Documents = {
  'main.cpp': initialCode,
  'idea.md': [
    '# 区间选择',
    '',
    '- 先按右端点排序。',
    '- 再依次选择不冲突区间。',
    '',
    '> 待确认：相等端点如何处理？',
  ].join('\n'),
  'cases.txt': [
    '输入：[(1, 3), (2, 4), (4, 6)]',
    '期望选择：2',
    '',
    '输入：[(0, 2), (2, 5), (4, 7)]',
    '待确认闭区间语义。',
  ].join('\n'),
};

export const files: Array<{ id: FileId; label: string; icon: string }> = [
  { id: 'main.cpp', label: 'main.cpp', icon: 'cpp' },
  { id: 'idea.md', label: 'idea.md', icon: 'md' },
  { id: 'cases.txt', label: 'cases.txt', icon: 'test' },
];
