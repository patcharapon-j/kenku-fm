export interface TaggedItem {
  title: string;
  tags?: string[];
}
export type LibrarySort = "manual" | "title" | "tags";
export function cleanTags(tags: string[]): string[] {
  return [
    ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ];
}
export function filterLibrary<T extends TaggedItem>(
  items: T[],
  query: string,
  tag: string,
  sort: LibrarySort,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const result = items.filter((item) => {
    const tags = cleanTags(item.tags ?? []);
    const text = [item.title, ...tags].join(" ").toLowerCase();
    return (
      (!tag || tags.includes(tag)) && words.every((word) => text.includes(word))
    );
  });
  if (sort !== "manual")
    result.sort((a, b) => {
      const primary =
        sort === "tags"
          ? cleanTags(a.tags ?? [])
              .sort()
              .join(",")
              .localeCompare(
                cleanTags(b.tags ?? [])
                  .sort()
                  .join(","),
              )
          : 0;
      return primary || a.title.localeCompare(b.title);
    });
  return result;
}
