
const express=require('express');
const {chromium}=require('playwright');
const app=express();
const PORT=process.env.PORT||10000;

async function getLinks(page,base){
 const links=await page.$$eval('a',as=>as.map(a=>a.href));
 return [...new Set(links.filter(l=>l.startsWith(base)))];
}

app.get('/crawl-capture',async(req,res)=>{
 const start=req.query.url;
 if(!start) return res.status(400).json({error:"Missing url"});

 const base=new URL(start).origin;
 const browser=await chromium.launch({args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1920,height:1080}});

 let queue=[start];
 let visited=new Set();
 let results=[];

 while(queue.length){
   const url=queue.shift();
   if(visited.has(url)) continue;
   visited.add(url);

   try{
     await page.goto(url,{waitUntil:'networkidle',timeout:60000});
     await page.waitForTimeout(1000);

     const newLinks=await getLinks(page,base);
     queue.push(...newLinks);

     const img=await page.screenshot({fullPage:true,type:'jpeg',quality:80});
     results.push({url,success:true,image:img.toString('base64')});
   }catch(e){
     results.push({url,success:false,error:e.message});
   }
 }

 await browser.close();
 res.json(results);
});

app.listen(PORT,()=>console.log("v5.1 worker running"));
