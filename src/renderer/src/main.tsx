import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

function App(): React.JSX.Element {
  return <div>TensorFold Desk</div>
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
