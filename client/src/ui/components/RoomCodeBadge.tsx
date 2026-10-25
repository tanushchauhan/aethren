interface RoomCodeBadgeProps {
  code: string;
}

export function RoomCodeBadge({ code }: RoomCodeBadgeProps) {
  const letters = code.trim().toUpperCase();
  return (
    <p className="ouam-room">
      <span className="ouam-room-label">Room</span>
      <span className="ouam-room-code" aria-label={`Room code ${letters.split('').join(' ')}`}>
        {letters}
      </span>
    </p>
  );
}
