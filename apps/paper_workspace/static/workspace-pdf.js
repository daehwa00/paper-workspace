async function loadPdfJs(){
  const pdfjs=await import('/vendor/pdfjs/pdf.mjs?v=__PDFJS_MJS_HASH__');
  pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs?v=__PDFJS_WORKER_HASH__';
  return pdfjs;
}

async function renderPdfPreviewLazy(binary,synctex,fallbackSynctex='',isCurrent=()=>true){
  const request=++pdfRenderRequest;
  const ensureCurrent=()=>{
    if(request===pdfRenderRequest&&isCurrent())return;
    const error=new Error('A newer PDF render replaced this request.');
    error.name='RenderingCancelledException';
    throw error;
  };
  const panel=document.querySelector('.preview-panel'),preview=$('paper-preview');
  const pdfjs=await loadPdfJs();
  ensureCurrent();
  const loadingTask=pdfjs.getDocument({data:binary.slice()});
  let published=false;
  try{
    const pdfDocument=await loadingTask.promise;
    ensureCurrent();
    const viewer=document.createElement('div');
    viewer.className='pdf-canvas-viewer';
    const firstPage=await pdfDocument.getPage(1);
    ensureCurrent();
    const firstBase=firstPage.getViewport({scale:1});
    let fitWidth=Math.max(1,preview.clientWidth-36);
    const firstScale=Math.max(.35,fitWidth/firstBase.width);
    const firstViewport=firstPage.getViewport({scale:firstScale});
    const entries=Array.from({length:pdfDocument.numPages},(_,index)=>{
      const pageNumber=index+1;
      const wrapper=document.createElement('div');
      wrapper.className='pdf-page';
      wrapper.dataset.page=String(pageNumber);
      wrapper.dataset.scale=String(firstScale);
      wrapper.style.width=`${firstViewport.width}px`;
      wrapper.style.minHeight=`${firstViewport.height}px`;
      const canvas=document.createElement('canvas');
      canvas.style.width=`${firstViewport.width}px`;
      canvas.style.height=`${firstViewport.height}px`;
      canvas.style.visibility='hidden';
      canvas.tabIndex=-1;
      canvas.setAttribute('role','button');
      canvas.setAttribute('aria-label',`PDF ${pageNumber}페이지 — 클릭하거나 Enter 키를 누르면 LaTeX 원문으로 이동`);
      wrapper.append(canvas);
      viewer.append(wrapper);
      return {pageNumber,canvas,wrapper,promise:null,task:null,rendered:false,scale:firstScale,base:firstBase};
    });
    const layoutEntry=entry=>{
      entry.scale=Math.max(.35,fitWidth/entry.base.width);
      entry.wrapper.dataset.scale=String(entry.scale);
      const width=entry.base.width*entry.scale,height=entry.base.height*entry.scale;
      entry.wrapper.style.width=`${width}px`;
      entry.wrapper.style.minHeight=`${height}px`;
      entry.canvas.style.width=`${width}px`;
      entry.canvas.style.height=`${height}px`;
    };
    const pages=entries.map(entry=>entry.wrapper);
    const tasks=new Set();
    const renderPage=entry=>{
      if(entry.rendered)return Promise.resolve();
      if(entry.promise)return entry.promise;
      entry.promise=(entry.pageNumber===1?Promise.resolve(firstPage):pdfDocument.getPage(entry.pageNumber)).then(page=>{
        if(!published)ensureCurrent();
        else if(activePdfDocument!==pdfDocument)return;
        const base=page.getViewport({scale:1});
        const measured=base.width!==entry.base.width||base.height!==entry.base.height;
        entry.base=base;
        if(published&&measured)window.PaperPdfViewport.relayout(panel,pages,()=>layoutEntry(entry));
        else layoutEntry(entry);
        const viewport=page.getViewport({scale:entry.scale});
        const desiredRatio=Math.min(devicePixelRatio||1,pdfMaxDevicePixelRatio)*pdfPreRenderZoom;
        const pixelBudgetRatio=Math.sqrt(pdfMaxCanvasPixels/(viewport.width*viewport.height));
        const renderRatio=Math.max(1,Math.min(desiredRatio,pixelBudgetRatio));
        entry.canvas.width=Math.floor(viewport.width*renderRatio);
        entry.canvas.height=Math.floor(viewport.height*renderRatio);
        const syncFromPoint=(clientX,clientY)=>{const rect=entry.canvas.getBoundingClientRect();syncPdfToSource(entry.pageNumber,(clientX-rect.left)*entry.base.width/rect.width,(clientY-rect.top)*entry.base.height/rect.height)};
        entry.canvas.onclick=event=>syncFromPoint(event.clientX,event.clientY);
        entry.canvas.onkeydown=event=>{if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();const rect=entry.canvas.getBoundingClientRect();syncFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)};
        const task=page.render({canvasContext:entry.canvas.getContext('2d'),viewport,transform:renderRatio===1?null:[renderRatio,0,0,renderRatio,0,0]});
        entry.task=task;
        tasks.add(task);
        return task.promise.then(()=>{entry.canvas.style.visibility='visible';entry.canvas.tabIndex=0;entry.rendered=true}).catch(error=>{
          // Virtualization may release a page while its canvas is rendering.
          if(error.name==='RenderingCancelledException'&&activePdfDocument===pdfDocument&&entry.task!==task)return;
          throw error;
        }).finally(()=>{if(entry.task===task)entry.task=null;tasks.delete(task)});
      });
      return entry.promise;
    };
    const releasePage=entry=>{entry.task?.cancel?.();entry.task=null;entry.promise=null;entry.rendered=false;entry.canvas.tabIndex=-1;entry.canvas.style.visibility='hidden';entry.canvas.width=0;entry.canvas.height=0};
    const entryByWrapper=new Map(entries.map(entry=>[entry.wrapper,entry]));
    const observer=new IntersectionObserver(observed=>{for(const item of observed){const entry=entryByWrapper.get(item.target);if(!entry)continue;if(item.isIntersecting)renderPage(entry).catch(()=>{});else if(entry.rendered||entry.task)releasePage(entry)}},{root:panel,rootMargin:'1200px 0px'});
    const resizeObserver=new ResizeObserver(()=>{
      if(activePdfDocument!==pdfDocument)return;
      const nextFitWidth=Math.max(1,preview.clientWidth-36);
      if(Math.abs(nextFitWidth-fitWidth)<1)return;
      fitWidth=nextFitWidth;
      window.PaperPdfViewport.relayout(panel,pages,()=>entries.forEach(layoutEntry));
      schedulePdfPageIndicatorUpdate();
    });
    const viewportSnapshot=window.PaperPdfViewport.capture(panel);
    const targetIndex=constrain((viewportSnapshot?.pageNumber||1)-1,0,entries.length-1);
    const hidden=!renderedPdfUrl&&!panel.getClientRects().length;
    const initialRender=renderPage(entries[0]);
    if(!hidden){
      await initialRender;
      if(targetIndex)await renderPage(entries[targetIndex]);
    }
    ensureCurrent();
    const currentAnchor=window.PaperPdfViewport.capture(panel);
    disposePdfPreview();
    activePdfDocument=pdfDocument;
    activePdfRenderTasks=tasks;
    activePdfObserver=observer;
    activePdfResizeObserver=resizeObserver;
    published=true;
    ++pdfRenderGeneration;
    renderedSynctex=String(synctex||'');
    renderedSynctexFallback=renderedSynctex.startsWith('id:')?String(fallbackSynctex||''):'';
    preview.classList.add('pdf-mode');
    viewer.style.zoom=String(layout.pdfZoom);
    preview.replaceChildren(viewer);
    window.PaperPdfViewport.restore(panel,pages,currentAnchor);
    entries.forEach(entry=>observer.observe(entry.wrapper));
    resizeObserver.observe(preview);
    schedulePdfPageIndicatorUpdate();
    if(hidden){
      // The observer can now cancel this raster when the panel is out of
      // view and restart it when the preview is selected.
      try{
        await initialRender;
      }catch(error){
        if(activePdfDocument===pdfDocument){
          disposePdfPreview();
          preview.classList.remove('pdf-mode');
          render();
        }
        throw error;
      }
      ensureCurrent();
    }
    setRenderedPdf(binary);
  }finally{
    if(!published)await loadingTask.destroy();
  }
}
async function renderCachedPdf(preview,isCurrent){
  try{
    await renderPdfPreviewLazy(preview.binary,preview.synctex,'',isCurrent);
    return true;
  }catch(error){
    if(error.name!=='RenderingCancelledException')reportClientError(error,'renderCachedPdf');
    return false;
  }
}
let assetPdfSession=null,assetPreviewGeneration=0;

function disposeAssetPdf(){
  ++assetPreviewGeneration;
  const session=assetPdfSession;
  assetPdfSession=null;
  if(!session)return;
  session.observer?.disconnect();
  for(const task of session.tasks)task.cancel();
  void session.loadingTask.destroy().catch(error=>reportClientError(error,'disposeAssetPdf'));
}

async function renderAssetPdf(path,asset,viewer,generation){
  const current=()=>activeAsset===path&&generation===assetPreviewGeneration;
  const loading=document.createElement('div');
  loading.className='asset-pdf-loading';
  loading.innerHTML='<span class="pdf-spinner" aria-hidden="true"></span><strong>PDF 미리보기 준비 중</strong>';
  viewer.replaceChildren(loading);
  let loadingTask,session;
  try{
    const pdfjs=await loadPdfJs();
    if(!current())return;
    loadingTask=pdfjs.getDocument({data:assetDataUrlBytes(asset.data)});
    const pdf=await loadingTask.promise;
    if(!current())return;
    const firstPage=await pdf.getPage(1);
    if(!current())return;

    const stage=$('asset-stage'),base=firstPage.getViewport({scale:1});
    const scale=Math.min(1.5,Math.max(.35,(stage.clientWidth-56)/base.width));
    const firstViewport=firstPage.getViewport({scale});
    const entries=new Map();
    viewer.replaceChildren();
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){
      const wrapper=document.createElement('div'),canvas=document.createElement('canvas');
      wrapper.className='asset-pdf-page';
      wrapper.style.minHeight=`${firstViewport.height}px`;
      canvas.style.width=`${firstViewport.width}px`;
      canvas.style.height=`${firstViewport.height}px`;
      wrapper.append(canvas);
      viewer.append(wrapper);
      entries.set(wrapper,{pageNumber,canvas,promise:null});
    }
    const renderEntry=(wrapper,entry)=>{
      if(entry.promise)return entry.promise;
      const pagePromise=entry.pageNumber===1?Promise.resolve(firstPage):pdf.getPage(entry.pageNumber);
      entry.promise=pagePromise.then(page=>{
        if(!current())return;
        const viewport=page.getViewport({scale}),ratio=Math.min(devicePixelRatio||1,2);
        entry.canvas.width=Math.floor(viewport.width*ratio);
        entry.canvas.height=Math.floor(viewport.height*ratio);
        entry.canvas.style.width=`${viewport.width}px`;
        entry.canvas.style.height=`${viewport.height}px`;
        wrapper.style.minHeight=`${viewport.height}px`;
        const task=page.render({canvasContext:entry.canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});
        session.tasks.add(task);
        return task.promise.finally(()=>session.tasks.delete(task));
      });
      return entry.promise;
    };
    const observer=new IntersectionObserver(items=>{
      for(const item of items)if(item.isIntersecting)renderEntry(item.target,entries.get(item.target)).catch(error=>{
        if(current())reportClientError(error,'renderAssetPdfPage');
      });
    },{root:stage,rootMargin:'700px 0px'});
    session={loadingTask,observer,tasks:new Set()};
    assetPdfSession=session;
    for(const wrapper of entries.keys())observer.observe(wrapper);
    const [wrapper,entry]=entries.entries().next().value;
    await renderEntry(wrapper,entry);
  }catch(error){
    if(!current())return;
    if(session)disposeAssetPdf();
    const message=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('span');
    message.className='asset-empty';
    title.textContent='PDF 미리보기 오류';
    detail.textContent=String(error.message||error);
    message.append(title,detail);
    viewer.replaceChildren(message);
  }finally{
    // Once installed, the session owns destruction, including cancellation.
    if(loadingTask&&!session)await loadingTask.destroy().catch(error=>reportClientError(error,'disposeAssetPdf'));
  }
}
