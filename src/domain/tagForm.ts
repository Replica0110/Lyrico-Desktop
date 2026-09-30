import type { AudioTrack, TagForm } from "../app/types";

export function splitGenreValues(value: string) {
  return [...new Set(value.split(/[;/,]/).map((genre) => genre.trim()).filter(Boolean))];
}

export function completeTagForm(values: Partial<TagForm>, original: AudioTrack): TagForm {
  const has = (field: keyof TagForm) => Object.prototype.hasOwnProperty.call(values, field);
  return {
    title: has("title") ? values.title ?? "" : original.title,
    artist: has("artist") ? values.artist ?? "" : original.artist,
    album: has("album") ? values.album ?? "" : original.album,
    albumArtist: has("albumArtist") ? values.albumArtist ?? "" : original.albumArtist,
    trackNumber: has("trackNumber") ? values.trackNumber : original.trackNumber,
    discNumber: has("discNumber") ? values.discNumber : original.discNumber,
    year: has("year") ? values.year ?? "" : original.year,
    genre: has("genre") ? values.genre ?? [] : splitGenreValues(original.genre),
    language: has("language") ? values.language ?? "" : original.language,
    composer: has("composer") ? values.composer ?? "" : original.composer,
    lyricist: has("lyricist") ? values.lyricist ?? "" : original.lyricist,
    copyright: has("copyright") ? values.copyright ?? "" : original.copyright,
    rating: has("rating") ? values.rating : original.rating,
    comment: has("comment") ? values.comment ?? "" : original.comment,
    lyrics: has("lyrics") ? values.lyrics ?? "" : original.lyrics,
    replayGainTrackGain: has("replayGainTrackGain") ? values.replayGainTrackGain ?? "" : original.replayGainTrackGain,
    replayGainTrackPeak: has("replayGainTrackPeak") ? values.replayGainTrackPeak ?? "" : original.replayGainTrackPeak,
    replayGainAlbumGain: has("replayGainAlbumGain") ? values.replayGainAlbumGain ?? "" : original.replayGainAlbumGain,
    replayGainAlbumPeak: has("replayGainAlbumPeak") ? values.replayGainAlbumPeak ?? "" : original.replayGainAlbumPeak,
    replayGainReferenceLoudness: has("replayGainReferenceLoudness") ? values.replayGainReferenceLoudness ?? "" : original.replayGainReferenceLoudness,
    coverDataUrl: has("coverDataUrl") ? values.coverDataUrl : undefined,
    removeCover: has("removeCover") ? values.removeCover ?? false : false,
    customTags: has("customTags") ? values.customTags ?? [] : [],
  };
}
