#最初版的BetterBUCT，已废弃。

----
----
----
----
# THEIA-Android

这是一个独立的 Capacitor Android App，支持 Android 10（API 29）及以上版本，启动后直接进入工作区，账号可在“设置”中通过 CAS 统一身份认证或教务 API 添加。应用提供只读教务信息：总览、课表、地图、成绩与考试、作业与测试、学业进度、教务通知、空闲教室和公开场馆查询；培养计划位于“学习工具”内。

登录和普通刷新先读取核心只读数据域；培养计划、成绩组成和空闲教室会按需读取，失败不会拖住课表、成绩等核心功能。场馆查询只访问 MOTION 的公开 GET 页面，不需要账号，也不包含预约操作。应用不提交选课、申请、上传、预约或其他学校侧操作。

## 构建 APK

```powershell
npm install
npm run android:build
```

Debug APK 输出在 `android/app/build/outputs/apk/debug/app-debug.apk`。

浏览器预览仅用于查看界面，不能完成 CAS 登录或把 Android WebView 的教务 Cookie 交给教务请求：

```powershell
npm run dev
```

Android 安装包会在应用内打开学校统一身份认证页面，认证成功后把教务会话 Cookie 交给 Capacitor 原生 HTTP，再读取教务数据。账号和密码只在学校认证页面中输入，不写入 THEIA 文件。
