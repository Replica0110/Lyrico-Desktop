async (page) => {
  await page.addInitScript(() => {
    localStorage.setItem('lyrico.language', 'zh-CN');
    const settings = {
  searchPageSize: 10,
  replayGainTargetLoudness: -18,
  replayGainPeakMode: "samplePeak",
  lyricFormat: "verbatimLrc",
  lyricsConversionMode: "none",
  showTranslation: true,
  showRomanization: true,
  onlyTranslationIfAvailable: false,
  removeEmptyLyricLines: true,
  lyricLineOrder: ["original", "romanization", "translation"],
  removeTagLineKeywords: [],
  ignoreShortAudio: false,
  lyricIndexEnabled: true,
  hiddenFolderPaths: [],
  artistPosterFolder: "C:/Music/Artist posters/Long directory name for layout verification",
  themeMode: "system",
  editFieldVisibility: {},
  editFieldOrder: ["basic", "track", "credits", "customTags", "replaygain", "lyrics", "cover"],
  renameCharacterMappings: {
    "\\": "＼", "/": "／", ":": "：", "*": "＊", "?": "？", "\"": "＂", "<": "＜", ">": "＞", "|": "｜",
  },
};
    const tracks = Array.from({length: 36}, (_, i) => ({id:String(i),path:`C:/Music/Album/${i}.flac`,fileName:`${i}.flac`,title:`测试歌曲 ${i+1}`,artist:'示例艺术家',album:'测试专辑',albumArtist:'示例艺术家',genre:'Pop',language:'',composer:'',lyricist:'',copyright:'',comment:'',lyrics:'',year:'2026',durationSeconds:210,format:'FLAC',hasLyrics:false,hasCover:false,replayGainTrackGain:'',replayGainTrackPeak:'',replayGainAlbumGain:'',replayGainAlbumPeak:'',replayGainReferenceLoudness:''}));
    tracks[0].artist='本兮/单小源'; tracks[0].album='合唱专辑'; tracks[1].artist='本兮'; tracks[1].album='个人专辑';
    const plugins = [
      {
        id:'musicbrainz', name:'MusicBrainz 元数据', versionCode:120, versionName:'1.2.0', author:'Lyrico',
        description:'从 MusicBrainz 检索专辑与曲目标签，支持按专辑整体匹配。',
        apiVersion:5, minHostApiVersion:5, entry:'index.js', includeDirs:[], enabled:true,
        capabilities:['searchSongs','getLyrics'], sourceStates:{metadata:{enabled:true,priority:0},covers:{enabled:true,priority:0}}, sortOrder:0,
        configFields:[
          {key:'endpoint',title:'服务地址',summary:'留空时使用官方服务',type:'text',defaultValue:'https://musicbrainz.org'},
          {key:'token',title:'访问令牌',type:'password',required:true,defaultValue:''},
          {key:'region',title:'地区',type:'dropdown',defaultValue:'CN',options:[{value:'CN',label:'中国大陆'},{value:'US',label:'美国'},{value:'JP',label:'日本'}]},
          {key:'useProxy',title:'使用代理',type:'switch',defaultValue:'false'},
          {key:'proxyUrl',title:'代理地址',type:'text',summary:'仅在启用代理时生效',dependency:{match:{key:'useProxy',value:'true'}},defaultValue:''},
          {key:'notes',title:'说明',type:'markdown',defaultValue:'## 使用说明\n\n- 需要网络连接\n- 每首曲目约消耗 1 次请求'},
        ],
        pluginDir:'C:/Plugins/musicbrainz', sortOrder:0,
        installedAt:'2026-09-01T10:00:00Z', updatedAt:'2026-10-01T10:00:00Z',
        config:{endpoint:'https://musicbrainz.org'},
      },
      {
        id:'lrclib', name:'LRCLIB 歌词', versionCode:210, versionName:'2.1.0', author:'community',
        description:'公开歌词库，按标题与艺术家检索同步歌词。',
        apiVersion:5, minHostApiVersion:5, entry:'main.js', includeDirs:[], enabled:false,
        capabilities:['searchSongs','getLyrics'], sourceStates:{lyrics:{enabled:true,priority:0}}, sortOrder:1, configFields:[],
        pluginDir:'C:/Plugins/lrclib', sortOrder:1,
        installedAt:'2026-08-20T10:00:00Z', updatedAt:'2026-09-20T10:00:00Z', config:{},
      },
    ];
    window.__uiTest = {settings,tracks,plugins,calls:[]};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener:()=>{}};
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:()=>1, unregisterCallback:()=>{},
      invoke:async (cmd,args) => {
        window.__uiTest.calls.push({cmd,args});
        if(cmd==='save_desktop_settings') {Object.assign(settings,args.settings); return null;}
        if(cmd==='load_desktop_settings') return settings;
        if(cmd==='load_artist_split_config') return {
  enabled: true,
  artistSeparator: "/",
  builtinSeparatorOverrides: {},
  hiddenBuiltinSeparatorIds: [],
  customSeparators: [],
  builtinNoSplitArtistOverrides: {},
  customNoSplitArtists: [],
};
        if(cmd==='load_library_tracks') return tracks;
        if(cmd==='load_source_plugins') return plugins;
        if(cmd==='set_source_plugin_enabled') return plugins.map(p=>p.id===args.pluginId?{...p,enabled:args.enabled}:p);
        if(cmd==='save_source_plugin_settings') return plugins.map(p=>p.id===args.pluginId?{...p,config:args.config}:p);
        if(cmd==='set_source_plugin_order') return [...plugins].sort((a,b)=>args.pluginIds.indexOf(a.id)-args.pluginIds.indexOf(b.id));
        if(cmd==='load_library_folders') return [{path:'C:/Music',trackCount:36}];
        if(cmd==='load_library_track'||cmd==='read_audio_file') return tracks.find(t=>t.path===args.path);
        if(cmd==='load_custom_tags') return [];
        if(cmd==='save_audio_tags') {
          // audioApi sends { update: { path, ...tagValues } }; merge it into the stored track and
          // hand back a complete AudioTrack (with path), like the Rust command does.
          // TagForm sends genre as string[] while AudioTrack stores genre as a single string.
          const update = args.update ?? args.values ?? {};
          const target = tracks.find(t=>t.path===update.path);
          if(!target) return null;
          const next = {...target};
          for(const [key,value] of Object.entries(update)) {
            if(key==='path'||value===undefined) continue;
            next[key] = key==='genre'&&Array.isArray(value) ? value.join('; ') : value;
          }
          Object.assign(target,next);
          return {...target, path:target.path};
        }
        if(cmd==='plugin:window|is_maximized') return false;
        if(cmd==='plugin:app|version') return '0.1.0';
        if(cmd==='plugin:event|listen') return 1;
        if(cmd.startsWith('load_')||cmd==='search_lyrics_lines'||cmd==='pick_paths') return [];
        return null;
      }
    };
  });
  await page.reload();
}
