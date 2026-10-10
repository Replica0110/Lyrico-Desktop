async (page) => {
  await page.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const artwork = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#35536d"/><text x="50" y="320" fill="white" font-size="72">Lyrico</text></svg>');
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      const custom = ['open_logs_directory','invoke_source_plugin','fetch_remote_image','render_plugin_lyrics'];
      if (custom.includes(cmd)) window.__uiTest.calls.push({cmd,args});
      if (cmd === 'open_logs_directory') return null;
      if (cmd === 'fetch_remote_image') return artwork;
      if (cmd === 'invoke_source_plugin') return args.functionName === 'getLyrics' ? {rawVerbatimLrc:'[00:01.00]测试歌词'} : [{id:'song-1',title:'麻雀',artist:'李荣浩',album:'麻雀',duration:252,coverUrl:artwork,fields:{album_artist:'李荣浩',genre:'Pop',year:'2019',track_number:1,disc_number:1,composer:'李荣浩',lyricist:'李荣浩',language:'zh',copyright:'Warner Music',comment:'匹配测试'}}];
      if (cmd === 'render_plugin_lyrics') return {text:args.result.rawVerbatimLrc,warnings:[],targetFormat:args.targetFormat};
      return original(cmd,args);
    };
  });
  await page.reload();
}
