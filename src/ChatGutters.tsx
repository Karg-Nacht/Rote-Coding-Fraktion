/** Decorative grid stays outside the shared timeline/composer column. */
export function ChatGutters() {
  return (
    <>
      <div className="chat-gutter chat-gutter-left" aria-hidden="true">
        <div className="chat-gutter-dots" />
      </div>
      <div className="chat-gutter chat-gutter-right" aria-hidden="true">
        <div className="chat-gutter-dots" />
      </div>
    </>
  );
}
