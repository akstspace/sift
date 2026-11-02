import React from 'react'
import ReactDOM from 'react-dom/client'
import './script-fonts.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import App from './App'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
if ('serviceWorker' in navigator) window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{})})
