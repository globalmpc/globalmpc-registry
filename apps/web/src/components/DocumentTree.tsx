import type { ReactNode } from "react";
import { childrenByParent, type TreeItem } from "@/lib/documents";

/**
 * Documents under `rootId`, nested by the document just above each one.
 *
 * Nested lists rather than a drawing: a screen reader reads the levels, and the page stays usable
 * when a change reaches dozens of documents.
 *
 * A document is rendered once per branch. The server does not send loops, but a tree that could
 * recurse forever on bad input would hang the page instead of showing it.
 */
export function DocumentTree<T extends TreeItem>({
  rootId,
  items,
  renderItem,
  testId,
}: {
  rootId: string;
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
  testId?: string;
}) {
  const children = childrenByParent(items);

  function branch(parentId: string, seen: ReadonlySet<string>): ReactNode {
    const kids = (children.get(parentId) ?? []).filter((item) => !seen.has(item.uploadId));
    if (kids.length === 0) return null;

    return (
      <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
        {kids.map((item) => (
          <li key={item.uploadId} style={{ margin: "4px 0" }}>
            {renderItem(item)}
            {branch(item.uploadId, new Set([...seen, item.uploadId]))}
          </li>
        ))}
      </ul>
    );
  }

  return <div data-testid={testId}>{branch(rootId, new Set([rootId]))}</div>;
}
