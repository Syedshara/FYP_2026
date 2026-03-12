import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'reactflow/dist/style.css'
import App from './App'

// Initialize theme
import './stores/themeStore'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
