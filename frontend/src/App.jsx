import ChatBox from './components/ChatBox.jsx'

function App() {
  return (
    <div className="w-full h-screen bg-[#0a0c10] flex items-center justify-center p-4">
      <div className="w-full h-full max-w-4xl bg-[#0a0c10] rounded-xl overflow-hidden border border-[#1e2535]">
        <ChatBox />
      </div>
    </div>
  )
}

export default App
