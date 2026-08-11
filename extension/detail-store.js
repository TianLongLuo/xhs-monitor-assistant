(function (root) {
  "use strict";

  function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  }

  function create() {
    const detailsById = new Map();

    function remember(notes) {
      for (const note of Array.isArray(notes) ? notes : []) {
        if (!note?.noteId || String(note.content || "").trim().length < 4) continue;
        const existing = detailsById.get(note.noteId) || {};
        detailsById.set(note.noteId, {
          ...existing,
          ...note,
          url: root.XhsMonitorNoteUtils?.preferredUrl?.(existing.url, note.url) || note.url || existing.url || "",
          tags: unique([...(existing.tags || []), ...(note.tags || [])]),
          imageUrls: unique([...(existing.imageUrls || []), ...(note.imageUrls || [])])
        });
      }
    }

    function merge(note = {}) {
      const detail = detailsById.get(note.noteId);
      if (!detail) return note;
      return {
        ...note,
        ...detail,
        noteId: note.noteId,
        url: root.XhsMonitorNoteUtils?.preferredUrl?.(note.url, detail.url) || note.url || detail.url || "",
        title: detail.title || note.title || "",
        author: detail.author || note.author || "",
        content: detail.content || note.content || "",
        tags: unique([...(note.tags || []), ...(detail.tags || [])]),
        mediaText: [note.mediaText, detail.mediaText].filter(Boolean).join(" ").slice(0, 6000),
        imageUrls: unique([...(note.imageUrls || []), ...(detail.imageUrls || [])]),
        keyword: note.keyword || detail.keyword || "",
        pageUrl: note.pageUrl || detail.pageUrl || ""
      };
    }

    function needsDetail(note = {}) {
      return Boolean(note.noteId) && !detailsById.has(note.noteId);
    }

    return Object.freeze({ remember, merge, needsDetail });
  }

  root.XhsMonitorDetailStore = Object.freeze({ create });
})(globalThis);
