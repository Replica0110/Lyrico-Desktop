async (page) => {
  await page.addInitScript(() => {
    localStorage.setItem('lyrico.language', window.name === 'english' ? 'en-US' : 'zh-CN');
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
    const tracks = Array.from({length: 139}, (_, i) => ({id:String(i),path:`C:/Music/Album/${i}.flac`,fileName:`${i}.flac`,title:`测试歌曲 ${i+1}`,artist:'示例艺术家',album:'测试专辑',albumArtist:'示例艺术家',genre:'Pop',language:'',composer:'',lyricist:'',copyright:'',comment:'',lyrics:'',year:'2026',durationSeconds:210,format:'FLAC',hasLyrics:false,hasCover:false,replayGainTrackGain:'',replayGainTrackPeak:'',replayGainAlbumGain:'',replayGainAlbumPeak:'',replayGainReferenceLoudness:''}));
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

    tracks.forEach((track,i) => { track.hasLyrics=i%3!==0; track.hasCover=i%2===0; if(i%2===0) Object.assign(track,{replayGainTrackGain:'-8.51 dB',replayGainTrackPeak:'1.00357',replayGainReferenceLoudness:'-18 LUFS'}); });
    const types=['exportLyrics','exportCover','replayGain','editTags','formatLyrics','renameFiles','matchMetadata','deleteFiles'];
    const tasks=Array.from({length:24},(_,i)=>({taskId:`history-${i}`,taskType:types[i%8],status:i%3===0?'failed':'succeeded',total:139,current:139,successCount:137,failureCount:i%3===0?1:0,skippedCount:1,createdAt:String(1791597450-i*60),updatedAt:String(1791597450-i*60),configJson:i%8===6?JSON.stringify({matchMode:'lyrics'}):undefined}));
    const itemStore=new Map(tasks.map(task=>[task.taskId,tracks.map((track,i)=>({itemId:`${task.taskId}:${i}`,taskId:task.taskId,songPath:track.path,fileName:track.fileName,status:i===1&&task.failureCount?'failed':i===2?'skipped':'succeeded',progress:1,errorMessage:i===1?'Cannot write to this audio file: access denied':i===2?'No embedded lyrics':undefined,resultJson:JSON.stringify(task.taskType.startsWith('export')?{outputPath:`C:/Exports/${track.fileName}.lrc`}:{changedFields:['cover','lyricsOffset']}),createdAt:task.createdAt,updatedAt:task.updatedAt}))]));
    plugins[1].enabled=true;
    const callbacks=new Map(),listeners=new Map(); let callbackId=10;
    const original=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.transformCallback=fn=>{callbacks.set(++callbackId,fn);return callbackId;};
    window.__uiTest.tasks=tasks; window.__uiTest.items=itemStore;
    window.__uiTest.emit=(event,payload)=>{for(const [id,listener] of listeners) if(listener.event===event) callbacks.get(listener.handler)?.({id,event,payload});};
    window.__uiTest.update=(id,status)=>{const task=tasks.find(t=>t.taskId===id);Object.assign(task,{status,progress:status==='running'?.5:1,current:status==='running'?1:task.total,successCount:status==='running'?0:Math.max(0,task.total-2),failureCount:status==='running'?0:Math.min(task.total,1),skippedCount:status==='running'?0:Number(task.total>1),updatedAt:String(Date.now()/1000)});itemStore.get(id).forEach((item,i)=>Object.assign(item,{status:status==='running'?(i===0?'running':'queued'):(i===1?'failed':i===2?'skipped':'succeeded'),progress:status==='running'?.5:1,errorMessage:i===1?'Write permission denied':undefined}));window.__uiTest.emit('batch-task-updated',{...task});};
    window.__TAURI_INTERNALS__.invoke=async(cmd,args)=>{
      if(cmd==='plugin:event|listen'){listeners.set(args.handler,args);return args.handler;}
      if(cmd==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
      if(cmd==='load_batch_tasks')return tasks.map(t=>({...t}));
      if(cmd==='load_batch_task_items'){window.__uiTest.calls.push({cmd,args});if(window.__uiTest.failItems)throw Error('Read failed');return (itemStore.get(args.taskId)??[]).map(item=>({...item}));}
      if(cmd==='create_batch_task'){window.__uiTest.calls.push({cmd,args});const task={taskId:'run-'+tasks.length,taskType:args.taskType,status:'queued',total:args.songPaths.length,current:0,successCount:0,failureCount:0,skippedCount:0,configJson:args.configJson,createdAt:String(Date.now()/1000),updatedAt:String(Date.now()/1000)};tasks.unshift(task);itemStore.set(task.taskId,args.songPaths.map((path,i)=>({itemId:task.taskId+':'+i,taskId:task.taskId,songPath:path,fileName:path.split('/').pop(),status:'queued',progress:0,createdAt:task.createdAt,updatedAt:task.updatedAt})));return {...task};}
      if(cmd==='retry_failed_batch_items'){window.__uiTest.calls.push({cmd,args});const source=tasks.find(t=>t.taskId===args.taskId);const failed=itemStore.get(args.taskId).filter(i=>i.status==='failed'&&(!args.itemIds||args.itemIds.includes(i.itemId)));const task=await window.__TAURI_INTERNALS__.invoke('create_batch_task',{taskType:source.taskType,configJson:source.configJson,songPaths:failed.map(i=>i.songPath)});return window.__TAURI_INTERNALS__.invoke('start_batch_task',{taskId:task.taskId});}
      if(cmd==='start_batch_task'){window.__uiTest.update(args.taskId,'running');return {...tasks.find(t=>t.taskId===args.taskId)};}
      if(cmd==='cancel_batch_task'){window.__uiTest.update(args.taskId,'cancelled');return {...tasks.find(t=>t.taskId===args.taskId)};}
      if(cmd==='delete_batch_tasks'){for(const id of args.taskIds){const i=tasks.findIndex(t=>t.taskId===id);if(i>=0)tasks.splice(i,1);}return;}
      if(cmd==='preview_batch_rename')return args.paths.map(path=>({originalPath:path,originalFileName:path.split('/').pop(),newPath:path.replace('.flac',' renamed.flac'),newFileName:path.split('/').pop().replace('.flac',' renamed.flac'),changed:true,hasConflict:false}));
      return original(cmd,args);
    };
  });
  await page.reload();
}
