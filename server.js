
const express=require('express');
const {chromium}=require('playwright');

const app=express();
const PORT=process.env.PORT||10000;

async function getLinks(page,baseUrl){
  const links=await page.$$eval('a',as=>as.map(a=>a.href));
  return [...new Set(links.filter(l=>l.startsWith(baseUrl)))];
}

async function capture(page,url){
  await page.goto(url,{waitUntil:'networkidle',timeout:60000});
  await page.waitForTimeout(1500);
  return await page.screenshot({fullPage:true,type:'jpeg',quality:80});
}

app.get('/crawl-capture',async(req,res)=>{
  const start=req.query.url;
  if(!start) return res.status(400).json({error:"Missing url"});

  const base=new URL(start).origin;

  const browser=await chromium.launch({args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1920,height:1080}});

  let urls=[start];
  let visited=new Set();

  let all=[];

  while(urls.length){
    const url=urls.shift();
    if(visited.has(url)) continue;
    visited.add(url);

    try{
      await page.goto(url,{waitUntil:'networkidle',timeout:60000});
      const newLinks=await getLinks(page,base);
      urls.push(...newLinks);

      const img=await capture(page,url);

      all.push({
        url,
        success:true,
        image:img.toString('base64')
      });

    }catch(e){
      all.push({url,success:false,error:e.message});
    }
  }

  await browser.close();
  res.json(all);
});

app.listen(PORT,()=>console.log("v5 crawler worker running"));
