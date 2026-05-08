import TopNav from './TopNav.jsx'

export default function Layout({ children }) {
  return (
    <>
      <TopNav />
      {children}
    </>
  )
}
