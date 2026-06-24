# 離線電子書閱讀器

上傳 PDF → 解析成可重排的電子書,左右滑動換頁,手機可離線閱讀的 PWA。

- 純前端:PDF 解析、渲染都在瀏覽器端,沒有後端、書不會上傳到任何伺服器
- 兩種閱讀模式:**重排**(可調字級)/ **原頁**(忠實渲染,雙擊放大)
- 章節目錄、閱讀進度、離線快取(Service Worker + IndexedDB)

## 開發

```bash
npm install
npm run dev
```

## 部署到 GitHub Pages

1. 在 GitHub 建一個新的 repo(例如 `ebook`)。
2. 把本專案推上去:
   ```bash
   git remote add origin https://github.com/<你的帳號>/<repo>.git
   git push -u origin main
   ```
3. 到 repo 的 **Settings → Pages → Build and deployment**,把 **Source** 設為 **GitHub Actions**。
4. 推上去後 Actions 會自動 build 並部署,網址是 `https://<你的帳號>.github.io/<repo>/`。
5. 手機連網開那個網址一次,讓 Service Worker 完成快取,再「加入主畫面」即可離線使用。

> 部署流程會自動把 Vite 的 base 設成 `/<repo>/`,不需手動改設定。
