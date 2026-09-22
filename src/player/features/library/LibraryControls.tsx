import React, { useState } from "react";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import Autocomplete from "@mui/material/Autocomplete";
import {
  cleanTags,
  filterLibrary,
  LibrarySort,
  TaggedItem,
} from "./libraryFilter";

export function TagsField({
  tags,
  onChange,
}: {
  tags?: string[];
  onChange: (tags: string[]) => void;
}) {
  return (
    <Autocomplete
      multiple
      freeSolo
      options={[]}
      value={tags ?? []}
      onChange={(_, values) => onChange(cleanTags(values))}
      renderInput={(params) => (
        <TextField
          {...params}
          margin="dense"
          label="Tags"
          helperText="Type a tag and press Enter"
        />
      )}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.stopPropagation();
      }}
    />
  );
}
export function useLibraryFilter<T extends TaggedItem>(items: T[]) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<LibrarySort>("manual");
  const tags = cleanTags(items.flatMap((item) => item.tags ?? [])).sort();
  const visible = filterLibrary(
    items,
    query,
    tags.includes(tag) ? tag : "",
    sort,
  );
  const active = Boolean(
    query || (tags.includes(tag) && tag) || sort !== "manual",
  );
  const controls = (
    <Stack spacing={1} sx={{ mb: 2 }} onKeyDown={(e) => e.stopPropagation()}>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          fullWidth
          label="Search names or tags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <TextField
          select
          size="small"
          label="Tag"
          value={tags.includes(tag) ? tag : ""}
          onChange={(e) => setTag(e.target.value)}
          sx={{ minWidth: 110 }}
        >
          <MenuItem value="">All tags</MenuItem>
          {tags.map((value) => (
            <MenuItem key={value} value={value}>
              {value}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as LibrarySort)}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="manual">Saved order</MenuItem>
          <MenuItem value="title">Name</MenuItem>
          <MenuItem value="tags">Tags</MenuItem>
        </TextField>
      </Stack>
      <Typography variant="caption">
        {visible.length} of {items.length} items
        {active
          ? " • Clear search and filters and use saved order to reorder items"
          : ""}
      </Typography>
      {!visible.length && <Typography>No matching audio.</Typography>}
    </Stack>
  );
  return { visible, controls, active };
}
